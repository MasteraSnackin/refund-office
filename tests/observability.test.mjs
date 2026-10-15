import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalObserver, redactTraceAttributes } from '../server/observability.mjs';

test('actual nested and concurrent operations have isolated parents and return their original results', async () => {
  const observer = createLocalObserver();
  const result = { unchanged: true }; let invoked = false, callbackContext;
  const running = observer.span('refund.investigation', { synthetic: true }, async context => {
    invoked = true; callbackContext = context;
    assert.equal(observer.snapshot().spans.length, 0);
    await Promise.resolve();
    return observer.span('refund.policy', { synthetic: true, 'span.kind': 'TOOL' }, () => result);
  });
  assert.equal(invoked, true, 'business callback must start before the first await');
  const other = observer.span('refund.intake', { synthetic: true }, async () => 7);
  assert.equal(await running, result);
  assert.equal(await other, 7);
  const spans = observer.snapshot().spans;
  const parent = spans.find(x => x.name === 'refund.investigation');
  const child = spans.find(x => x.name === 'refund.policy');
  const unrelated = spans.find(x => x.name === 'refund.intake');
  assert.equal(parent.spanId, callbackContext.spanId);
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(child.traceId, parent.traceId);
  assert.equal(unrelated.parentSpanId, null);
  assert.notEqual(unrelated.traceId, parent.traceId);
  for (const span of spans) {
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    assert.equal(span.status, 'OK');
  }
});

test('allowlists remove raw text, credentials, identity and hostile names without reading getters', async () => {
  const observer = createLocalObserver({ projectName: 'someone@example.test', runId: 'private-key-value' });
  let getterCalls = 0;
  const attributes = { synthetic: true, 'span.kind': 'LLM', provider: 'local', caseId: 'RF-2008', packId: 'focused-12',
    complaint: 'Private customer statement', customerStatement: 'Private statement', sourceReference: 'https://private.test',
    apiKey: 'sk-private', token: 'secret', userId: 'private-user', error: 'private-error', 'checks.count': 3,
    action: 'sk-private', amountMinor: -1, arbitrary: { token: 'nested-secret' } };
  Object.defineProperty(attributes, 'outcome', { enumerable: true, get() { getterCalls++; throw Error('secret'); } });
  await observer.span('Private customer statement', attributes, context => {
    context.setAttributes({ 'checks.passed': 2, 'decision.state': 'awaiting-approval', note: 'private-note' });
  });
  assert.equal(getterCalls, 0);
  const snapshot = observer.snapshot(), span = snapshot.spans[0];
  assert.equal(span.name, 'operation'); assert.equal(span.kind, 'LLM');
  assert.deepEqual(span.attributes, { synthetic: true, 'span.kind': 'LLM', provider: 'local', caseId: 'RF-2008', packId: 'focused-12', 'checks.count': 3, 'checks.passed': 2, 'decision.state': 'awaiting-approval' });
  assert.doesNotMatch(JSON.stringify(snapshot), /Private|private|secret|someone|https:/);
  assert.equal(snapshot.projectName, 'refund-office-local');
  assert.deepEqual(redactTraceAttributes({ caseId: 'RF-2008', synthetic: false }), { synthetic: false });
  await observer.span('refund.investigation', { 'span.kind': 'unknown-private-kind' }, () => {});
  const unknown = observer.snapshot().spans[1];
  assert.equal(unknown.kind, 'CHAIN');
  assert.deepEqual(unknown.attributes, {});
  assert.doesNotMatch(JSON.stringify(unknown), /unknown-private-kind/);
});

test('original synchronous and asynchronous errors are rethrown exactly without reading their text', async () => {
  const observer = createLocalObserver();
  const error = new Error('DO NOT SAVE THIS MESSAGE');
  Object.defineProperty(error, 'stack', { get() { throw Error('must not read'); } });
  for (const callback of [() => { throw error; }, async () => { throw error; }]) {
    await assert.rejects(observer.span('refund.review', {}, callback), value => value === error);
  }
  assert.equal(observer.snapshot().spans.length, 2);
  assert.ok(observer.snapshot().spans.every(span => span.status === 'ERROR'));
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /DO NOT|must not read/);
});

test('empty polls are omitted and late attributes cannot rewrite a completed span', async () => {
  const observer = createLocalObserver(); let captured;
  assert.equal(await observer.span('refund.investigation.claim', {}, () => null, { omitNull: true }), null);
  assert.equal(observer.snapshot().spans.length, 0);
  await observer.span('refund.review.decide', { synthetic: true }, context => { captured = context; context.setAttributes({ 'decision.state': 'closed-no-refund' }); });
  const before = observer.snapshot();
  captured.setAttributes({ 'decision.state': 'approved' });
  assert.deepEqual(observer.snapshot(), before);
  before.spans[0].attributes.synthetic = false;
  assert.equal(observer.snapshot().spans[0].attributes.synthetic, true);
});

test('bounded JSONL keeps the newest completed spans and private file mode without changing results', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'refund-observer-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const filePath = join(folder, 'invocation.jsonl');
  const observer = createLocalObserver({ filePath, maxSpans: 3, maxBytes: 4096 });
  for (let revision = 1; revision <= 20; revision++) {
    assert.equal(await observer.span('refund.review', { 'case.revision': revision }, () => revision), revision);
  }
  const status = await observer.flush();
  assert.equal(status.completedSpans, 20); assert.equal(status.retainedSpans, 3); assert.equal(status.droppedSpans, 17); assert.equal(status.writeState, 'saved');
  const file = await readFile(filePath, 'utf8');
  assert.deepEqual(file.trim().split('\n').map(line => JSON.parse(line).attributes['case.revision']), [18, 19, 20]);
  assert.ok(Buffer.byteLength(file) <= 4096);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('byte limits drop oversized spans and local write failures remain visible and non-fatal', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'refund-observer-fail-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const tiny = createLocalObserver({ maxBytes: 256 });
  await tiny.span('refund.evidence', { synthetic: true }, () => 11);
  assert.equal(tiny.status().retainedSpans, 0); assert.equal(tiny.status().droppedSpans, 1);
  const failing = createLocalObserver({ filePath: folder });
  const result = { success: true };
  assert.equal(await failing.span('refund.evidence', {}, () => result), result);
  const status = await failing.flush();
  assert.equal(status.writeState, 'failed'); assert.ok(status.writeErrors > 0);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(folder));
});

test('concurrent completions around persistence boundaries drain to the exact final retained snapshot', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'refund-observer-boundary-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const filePath = join(folder, 'boundary.jsonl'), observer = createLocalObserver({ filePath, maxSpans: 32 });
  const batches = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    batches.push(observer.span('refund.investigation', { 'case.revision': iteration }, async () => {
      // Spread completions through file-system turns, microtasks and flush readbacks.
      await new Promise(resolve => setImmediate(resolve));
      await observer.flush();
      await Promise.resolve();
    }));
    await Promise.resolve();
  }
  await Promise.all(batches);
  await observer.span('refund.review', { 'case.revision': 99 }, () => true);
  assert.equal((await observer.flush()).writeState, 'saved');
  assert.deepEqual((await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), observer.snapshot().spans);
  assert.equal(observer.snapshot().spans.at(-1).attributes['case.revision'], 99);
});

test('recording failures call a mutation once and never mask its original rejection', async () => {
  const observer = createLocalObserver({ clock: () => { throw Error('private clock detail'); } });
  let calls = 0; const result = {};
  assert.equal(await observer.span('refund.review', {}, () => { calls++; return result; }), result);
  assert.equal(calls, 1);
  const error = { private: 'original' };
  await assert.rejects(observer.span('refund.review', {}, () => { calls++; throw error; }), value => value === error);
  assert.equal(calls, 2); assert.equal(observer.status().recordingErrors, 2);
  assert.deepEqual(observer.snapshot().spans, []);
});

test('no ambient credential or network function is used by recording or persistence', async t => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw Error('network forbidden'); };
  t.after(() => { globalThis.fetch = previous; });
  const observer = createLocalObserver();
  await observer.span('refund.intake', { synthetic: true }, () => true); await observer.flush();
  assert.equal(calls, 0); assert.equal(observer.status().network, false);
});
