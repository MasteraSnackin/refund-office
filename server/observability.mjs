import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

// This module has no exporter, network client, environment lookup or global tracer.
// Only completed, actually invoked operations are recorded. Text from cases and
// exception objects is never inspected. Adding an attribute requires a review here.
const enums = {
  'span.kind': ['CHAIN', 'TOOL', 'LLM'],
  component: ['intake', 'investigation', 'review', 'evidence', 'policy', 'payment', 'evaluation', 'runtime', 'engine'],
  action: ['enqueue', 'claim', 'propose', 'finish', 'approve', 'review', 'decide', 'clarify', 'recover', 'investigate', 'hold', 'verify-hold', 'check', 'evaluate', 'run', 'replay', 'compare', 'reserve'],
  provider: ['local', 'openai', 'anthropic'],
  analyser: ['local', 'local-rules', 'local-analyser', 'openai', 'anthropic'],
  analyserMode: ['local-rules', 'controlled-test', 'provider-response'],
  stage: ['reception', 'intake', 'evidence', 'investigation', 'policy', 'review', 'payment', 'archive', 'evaluation'],
  outcome: ['pass', 'fail', 'passed', 'failed', 'held', 'awaiting-approval', 'awaiting-evidence', 'approved-not-submitted', 'historical-remedy', 'already-resolved', 'closed-no-refund', 'duplicate', 'completed', 'error', 'unresolved'],
  'decision.state': ['pending', 'awaiting-approval', 'awaiting-evidence', 'approved', 'approved-not-submitted', 'rejected', 'held', 'closed', 'historical-remedy', 'already-resolved', 'closed-no-refund', 'review-required'],
  'evaluation.kind': ['deterministic', 'expected-outcome', 'privacy', 'policy', 'approval-gate'],
  'evaluation.result': ['pass', 'fail', 'passed', 'failed', 'not-evaluated'],
};
const numbers = new Set(['case.revision', 'caseRevision', 'amountMinor', 'records.count', 'checks.count', 'checks.passed', 'evaluation.passed', 'evaluation.failed', 'evaluation.total']);
const packs = new Set(['focused-12', 'busy-office-50', 'rehearsal-12', 'busy-50', 'focused', 'busy-office']);
const operations = ['intake', 'investigation', 'review', 'evidence', 'policy', 'payment', 'evaluation', 'enqueue', 'claim', 'propose', 'finish', 'approve', 'decide', 'clarify', 'recover', 'investigate', 'check', 'evaluate', 'run', 'compare', 'reserve'];
const names = new Set(['operation', ...operations, ...operations.map(x => `refund.${x}`), ...operations.flatMap(x => operations.map(y => `${x}.${y}`)), ...operations.flatMap(x => operations.map(y => `refund.${x}.${y}`))]);
names.add('refund.investigation.hold');
names.add('refund.investigation.verify-hold');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TRACE_LIMITS = Object.freeze({ defaultSpans: 512, maxSpans: 2048, defaultBytes: 1024 * 1024, maxBytes: 4 * 1024 * 1024 });

export function redactTraceAttributes(input) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  // Descriptors avoid invoking getters on arbitrary application objects.
  const values = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(values)) {
    if (!Object.hasOwn(descriptor, 'value')) continue;
    const value = descriptor.value;
    if (Object.hasOwn(enums, key) && enums[key].includes(value)) result[key] = value;
    else if (key === 'model' && typeof value === 'string' && /^(?:local-rules-v[0-9]+|(?:gpt|o[1-9]|claude)[a-zA-Z0-9._:-]{0,76})$/.test(value)) result[key] = value;
    else if (numbers.has(key) && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else if (key === 'synthetic' && typeof value === 'boolean') result[key] = value;
    else if (key === 'packId' && packs.has(value)) result[key] = value;
    else if (key === 'caseId' && values.synthetic?.value === true && typeof value === 'string' && /^RF-?\d{1,8}$/.test(value)) result[key] = value;
  }
  return result;
}

function bounded(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function project(value) {
  return typeof value === 'string' && /^refund-office(?:[._-][a-z0-9-]{1,40})?$/.test(value) ? value : 'refund-office-local';
}
function safeName(value) { return names.has(value) ? value : 'operation'; }
export function isSafeTraceName(value) { return names.has(value); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** Bounded recorder. clock(), if supplied for tests, returns epoch milliseconds. */
export function createLocalObserver({ filePath, runId, projectName, clock, maxSpans, maxBytes } = {}) {
  const context = new AsyncLocalStorage();
  const id = typeof runId === 'string' && uuid.test(runId) ? runId : randomUUID();
  const projectLabel = project(projectName);
  const countLimit = bounded(maxSpans, TRACE_LIMITS.defaultSpans, 1, TRACE_LIMITS.maxSpans);
  const byteLimit = bounded(maxBytes, TRACE_LIMITS.defaultBytes, 256, TRACE_LIMITS.maxBytes);
  let records = [], bytes = 0, dropped = 0, completed = 0, active = 0;
  let writeState = filePath ? 'idle' : 'memory-only', writeErrors = 0, recordingErrors = 0;
  let pendingWrite = null, dirty = false;

  function snapshot() {
    return { schemaVersion: 1, format: 'refund-office-local-traces', runId: id, projectName: projectLabel,
      privacy: 'allowlisted-metadata-only', spans: records.map(x => copy(x.record)),
      retention: { maxSpans: countLimit, maxBytes: byteLimit, droppedSpans: dropped } };
  }
  function status() {
    return { enabled: true, mode: 'local-only', network: false, runId: id, projectName: projectLabel,
      activeSpans: active, completedSpans: completed, retainedSpans: records.length, retainedBytes: bytes,
      droppedSpans: dropped, recordingErrors, writeErrors, writeState,
      storage: filePath ? 'bounded-jsonl' : 'memory', maxSpans: countLimit, maxBytes: byteLimit };
  }
  function scheduleWrite() {
    if (!filePath) return;
    dirty = true;
    if (pendingWrite) return;
    writeState = 'pending';
    pendingWrite = (async () => {
      while (dirty) {
        dirty = false;
        const contents = records.map(x => x.line).join('');
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
          await rename(temporary, filePath);
          writeState = 'saved';
        } catch {
          writeErrors += 1; writeState = 'failed';
          await unlink(temporary).catch(() => {});
        }
      }
    })().catch(() => { writeErrors += 1; writeState = 'failed'; }).finally(() => {
      pendingWrite = null;
      // A completion may arrive after the loop exits but before this finally.
      // It has already marked dirty; start its write without waiting for more work.
      if (dirty) scheduleWrite();
    });
  }
  function complete(record) {
    completed += 1;
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    if (size > byteLimit) { dropped += 1; return; }
    records.push({ record, line, size }); bytes += size;
    while (records.length > countLimit || bytes > byteLimit) {
      bytes -= records.shift().size; dropped += 1;
    }
    scheduleWrite();
  }
  async function span(name, attributes, callback, { omitNull = false } = {}) {
    if (typeof callback !== 'function') throw new TypeError('A trace span requires an operation callback.');
    let start, startMono, local, safeAttributes;
    try {
      const parent = context.getStore();
      start = clock ? BigInt(Math.trunc(Number(clock()) * 1e6)) : BigInt(Date.now()) * 1000000n;
      startMono = process.hrtime.bigint();
      local = Object.freeze({ traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), parentSpanId: parent?.spanId ?? null });
      safeAttributes = redactTraceAttributes(attributes);
    } catch {
      recordingErrors += 1;
      // Instrumentation failure cannot prevent or repeat the business operation.
      return callback(Object.freeze({ traceId: null, spanId: null }));
    }
    active += 1;
    let open = true;
    const callbackContext = Object.freeze({ traceId: local.traceId, spanId: local.spanId,
      setAttributes(next) {
        if (!open) return;
        try { safeAttributes = { ...safeAttributes, ...redactTraceAttributes(next) }; }
        catch { recordingErrors += 1; }
      } });
    let result, failed = false;
    try {
      result = await context.run(local, () => callback(callbackContext));
      return result;
    } catch (error) { failed = true; throw error; }
    finally {
      active -= 1;
      open = false;
      try {
        if (!(omitNull && !failed && result === null)) {
          const end = clock ? BigInt(Math.trunc(Number(clock()) * 1e6)) : start + process.hrtime.bigint() - startMono;
          if (end < start || start < 0n) throw new Error('Invalid trace clock.');
          complete({ schemaVersion: 1, runId: id, traceId: local.traceId, spanId: local.spanId,
            parentSpanId: local.parentSpanId, name: safeName(name), kind: safeAttributes['span.kind'] ?? 'CHAIN',
            startTimeUnixNano: start.toString(), endTimeUnixNano: end.toString(), status: failed ? 'ERROR' : 'OK', attributes: safeAttributes });
        }
      } catch { recordingErrors += 1; }
    }
  }
  async function flush() {
    while (pendingWrite || dirty) {
      if (!pendingWrite && dirty) scheduleWrite();
      if (pendingWrite) await pendingWrite;
    }
    return status();
  }
  return Object.freeze({ span, status, snapshot, flush });
}
