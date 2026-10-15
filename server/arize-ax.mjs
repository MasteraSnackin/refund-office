import { createHash } from 'node:crypto';
import { isSafeTraceName, redactTraceAttributes, TRACE_LIMITS } from './observability.mjs';

// Prepared against Arize's official HTTPSpanExporter and OTLP trace_service.proto.
// https://github.com/Arize-ai/arize-otel-python/blob/main/src/arize/otel/otel.py
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto
// This is a deliberately small OTLP protobuf writer, not the Arize SDK. Only
// injected transports are tested here; real account acceptance is unverified.
export const ARIZE_ENDPOINTS = Object.freeze({ us: 'https://otlp.arize.com/v1/traces', eu: 'https://otlp.eu-west-1a.arize.com/v1/traces' });
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const hexTrace = /^[0-9a-f]{32}$/;
const hexSpan = /^[0-9a-f]{16}$/;
const timestamp = /^[1-9]\d{0,19}$/;
const safeProject = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,99}$/.test(value);
const fail = code => { const error = new Error('The selected trace export or its configuration is not valid.'); error.code = code; throw error; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function varint(input) {
  let value = BigInt(input); const result = [];
  if (value < 0n) fail('invalid_unsigned_value');
  do { const byte = Number(value & 127n); value >>= 7n; result.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(result);
}
function lengthField(number, bytes) { return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); }
function stringField(number, value) { return lengthField(number, Buffer.from(value, 'utf8')); }
function integerField(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function fixed64Field(number, value) {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([varint(number * 8 + 1), bytes]);
}
function keyValue(key, value) {
  const any = typeof value === 'boolean' ? integerField(2, value ? 1 : 0) : typeof value === 'number' ? integerField(3, value) : stringField(1, value);
  return Buffer.concat([stringField(1, key), lengthField(2, any)]);
}
function encodeSpan(span) {
  const attributes = { ...span.attributes, 'openinference.span.kind': span.kind, 'refund-office.synthetic': true, 'refund-office.run.id': span.runId };
  return Buffer.concat([
    lengthField(1, Buffer.from(span.traceId, 'hex')), lengthField(2, Buffer.from(span.spanId, 'hex')),
    ...(span.parentSpanId ? [lengthField(4, Buffer.from(span.parentSpanId, 'hex'))] : []),
    stringField(5, span.name), integerField(6, 1), // OTLP SPAN_KIND_INTERNAL; OpenInference kind is an attribute.
    fixed64Field(7, span.startTimeUnixNano), fixed64Field(8, span.endTimeUnixNano),
    ...Object.entries(attributes).map(([key, value]) => lengthField(9, keyValue(key, value))),
    lengthField(15, integerField(3, span.status === 'ERROR' ? 2 : 1)),
  ]);
}
function encodeRequest(spans, projectName) {
  const resource = Buffer.concat(Object.entries({ 'service.name': 'refund-office', 'openinference.project.name': projectName, 'arize.project.name': projectName, 'arize.project.type': 'application' })
    .map(([key, value]) => lengthField(1, keyValue(key, value))));
  const scope = Buffer.concat([stringField(1, 'refund-office-local-observer'), stringField(2, '1')]);
  const scopeSpans = Buffer.concat([lengthField(1, scope), ...spans.map(span => lengthField(2, encodeSpan(span)))]);
  return lengthField(1, Buffer.concat([lengthField(1, resource), lengthField(2, scopeSpans)]));
}
function selectedSpan(value) {
  if (!value || value.schemaVersion !== 1 || !hexTrace.test(value.traceId) || /^0+$/.test(value.traceId) || !hexSpan.test(value.spanId) || /^0+$/.test(value.spanId)
    || value.parentSpanId !== null && (!hexSpan.test(value.parentSpanId) || /^0+$/.test(value.parentSpanId))
    || !isSafeTraceName(value.name) || !['CHAIN', 'TOOL'].includes(value.kind) || !['OK', 'ERROR'].includes(value.status)
    || !timestamp.test(value.startTimeUnixNano) || !timestamp.test(value.endTimeUnixNano)
    || BigInt(value.endTimeUnixNano) < BigInt(value.startTimeUnixNano) || BigInt(value.endTimeUnixNano) > 18446744073709551615n
    || typeof value.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.runId) || value.attributes?.synthetic !== true) fail('invalid_synthetic_span');
  const attributes = redactTraceAttributes(value.attributes);
  if (Object.keys(attributes).length !== Object.keys(value.attributes).length
    || Object.keys(attributes).some(key => attributes[key] !== value.attributes[key])
    || attributes['span.kind'] && attributes['span.kind'] !== value.kind) fail('unsafe_span_attributes');
  return { schemaVersion: 1, runId: value.runId, traceId: value.traceId, spanId: value.spanId, parentSpanId: value.parentSpanId,
    name: value.name, kind: value.kind, startTimeUnixNano: value.startTimeUnixNano, endTimeUnixNano: value.endTimeUnixNano,
    status: value.status, attributes };
}

/** Pure preparation: no environment lookup, file writes or network access. */
export function prepareArizeExport({ snapshot, selectedSpanIds, projectName, region } = {}) {
  if (!safeProject(projectName) || !Object.hasOwn(ARIZE_ENDPOINTS, region)) fail('invalid_destination');
  if (!snapshot || snapshot.format !== 'refund-office-local-traces' || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.spans)
    || snapshot.spans.length > TRACE_LIMITS.maxSpans || !Array.isArray(selectedSpanIds) || !selectedSpanIds.length
    || selectedSpanIds.length > 512 || new Set(selectedSpanIds).size !== selectedSpanIds.length
    || selectedSpanIds.some(id => typeof id !== 'string' || !hexSpan.test(id))) fail('explicit_selection_required');
  const selected = new Set(selectedSpanIds);
  const spans = snapshot.spans.filter(span => selected.has(span?.spanId)).map(selectedSpan);
  if (spans.length !== selected.size || new Set(spans.map(span => span.spanId)).size !== spans.length) fail('selection_mismatch');
  // A subset is permitted, but never claim that its missing parents were captured.
  const byId = new Map(spans.map(span => [span.spanId, span]));
  for (const span of spans) {
    const parent = byId.get(span.parentSpanId);
    if (parent && (parent.traceId !== span.traceId || parent.spanId === span.spanId)) fail('invalid_parent');
    const seen = new Set([span.spanId]); let cursor = parent;
    while (cursor) { if (seen.has(cursor.spanId)) fail('invalid_parent'); seen.add(cursor.spanId); cursor = byId.get(cursor.parentSpanId); }
  }
  const body = encodeRequest(spans, projectName);
  if (body.length > MAX_EXPORT_BYTES) fail('export_too_large');
  return { schemaVersion: 1, provider: 'arize-ax', format: 'otlp-http-protobuf', accountValidation: 'unverified',
    region, endpoint: ARIZE_ENDPOINTS[region], projectName, spanCount: spans.length,
    selectedSpanIds: spans.map(span => span.spanId), missingParentSpans: spans.filter(span => span.parentSpanId && !byId.has(span.parentSpanId)).length,
    syntheticOnly: true, sha256: hash(body), byteLength: body.length, bodyBase64: body.toString('base64'), spans };
}

// Strict bounded protobuf reader for ExportTraceServiceResponse. Provider message
// text is deliberately ignored rather than copied into logs, reports or errors.
function fields(bytes) {
  let offset = 0; const result = [];
  function readVarint() {
    let value = 0n, shift = 0n;
    for (let index = 0; index < 10 && offset < bytes.length; index++) {
      const byte = bytes[offset++]; if (index === 9 && byte > 1) fail('invalid_response'); value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value; shift += 7n;
    }
    fail('invalid_response');
  }
  while (offset < bytes.length) {
    const tag = Number(readVarint());
    if (!Number.isSafeInteger(tag) || tag > 0xffffffff) fail('invalid_response');
    const number = tag >>> 3, wire = tag & 7;
    if (!number) fail('invalid_response');
    if (wire === 0) result.push({ number, wire, value: readVarint() });
    else if (wire === 2) {
      const length = Number(readVarint());
      if (!Number.isSafeInteger(length) || offset + length > bytes.length) fail('invalid_response');
      result.push({ number, wire, value: bytes.subarray(offset, offset + length) }); offset += length;
    } else if (wire === 1 || wire === 5) { const size = wire === 1 ? 8 : 4; if (offset + size > bytes.length) fail('invalid_response'); result.push({ number, wire }); offset += size; }
    else fail('invalid_response');
  }
  return result;
}
function parseResponse(bytes, spanCount) {
  const outer = fields(bytes);
  if (outer.some(field => field.number !== 1 || field.wire !== 2) || outer.length > 1) fail('invalid_response');
  if (!outer.length) return { status: 'accepted', acceptedSpans: spanCount, rejectedSpans: 0, warning: false };
  const partial = fields(outer[0].value);
  if (partial.some(field => ![1, 2].includes(field.number) || field.wire !== (field.number === 1 ? 0 : 2))
    || new Set(partial.map(field => field.number)).size !== partial.length) fail('invalid_response');
  const rejectedSpans = Number(partial.find(field => field.number === 1)?.value ?? 0n);
  if (!Number.isSafeInteger(rejectedSpans) || rejectedSpans < 0 || rejectedSpans > spanCount) fail('invalid_response');
  const warning = Boolean(partial.find(field => field.number === 2)?.value.length);
  return { status: rejectedSpans ? 'partial' : 'accepted', acceptedSpans: spanCount - rejectedSpans, rejectedSpans, warning };
}
async function readBoundedResponse(response) {
  if (!response?.headers?.get || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-protobuf') fail('invalid_response');
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) fail('response_too_large');
  if (!response.body) return Buffer.alloc(0);
  if (typeof response.body.getReader !== 'function') fail('invalid_response');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); fail('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Separate explicit operation. The normal observer never creates or calls this. */
export function createArizeExporter({ networkEnabled = false, uploadEnabled = false, apiKey, spaceId, projectName, region,
  transport = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const attempts = new Map();
  async function upload(prepared, { selectionConfirmed = false, expectedSha256 } = {}) {
    if (networkEnabled !== true || uploadEnabled !== true) return { status: 'disabled', networkAttempted: false, automaticRetry: false, reason: 'Independent network and trace-upload opt-ins are required.' };
    if (selectionConfirmed !== true || typeof expectedSha256 !== 'string' || expectedSha256 !== prepared?.sha256) fail('selection_not_confirmed');
    if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 2048 || /[\s\x00-\x1f\x7f]/.test(apiKey)
      || typeof spaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(spaceId)
      || !safeProject(projectName) || !Object.hasOwn(ARIZE_ENDPOINTS, region) || typeof transport !== 'function') fail('invalid_configuration');
    const checked = prepareArizeExport({ snapshot: { schemaVersion: 1, format: 'refund-office-local-traces', spans: prepared.spans }, selectedSpanIds: prepared.selectedSpanIds, projectName, region });
    if (checked.sha256 !== prepared.sha256 || checked.bodyBase64 !== prepared.bodyBase64 || checked.projectName !== prepared.projectName
      || checked.endpoint !== prepared.endpoint || checked.region !== prepared.region || prepared.syntheticOnly !== true) fail('prepared_payload_changed');
    if (attempts.has(checked.sha256)) return { ...clone(await attempts.get(checked.sha256)), repeatedAttemptBlocked: true };
    if (attempts.size >= 64) fail('attempt_limit');
    const attempt = (async () => {
      const controller = new AbortController();
      let timer;
      const expiry = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000 ? timeoutMs : 10000); });
      try {
        const work = (async () => {
          const response = await transport(checked.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
            headers: { authorization: apiKey, 'arize-space-id': spaceId, 'arize-interface': 'otel', 'content-type': 'application/x-protobuf', accept: 'application/x-protobuf' },
            body: Buffer.from(checked.bodyBase64, 'base64') });
          if (response?.status !== 200) return { status: [400, 401, 403, 404, 413, 415, 422].includes(response?.status) ? 'rejected' : 'unconfirmed', httpStatus: Number.isInteger(response?.status) ? response.status : null };
          return parseResponse(await readBoundedResponse(response), checked.spanCount);
        })();
        const result = await Promise.race([work, expiry]);
        return { ...result, networkAttempted: true, automaticRetry: false, sha256: checked.sha256,
          // A collector acknowledgement does not prove workspace display or evaluator behaviour.
          accountValidation: 'unverified', evidence: result.status === 'accepted' || result.status === 'partial' ? 'collector-response-only' : 'no-confirmed-ingestion' };
      } catch {
        return { status: 'unconfirmed', networkAttempted: true, automaticRetry: false, sha256: checked.sha256,
          accountValidation: 'unverified', evidence: 'no-confirmed-ingestion' };
      } finally { clearTimeout(timer); }
    })();
    attempts.set(checked.sha256, attempt);
    return clone(await attempt);
  }
  return Object.freeze({ upload, status: () => ({ mode: networkEnabled === true && uploadEnabled === true ? 'explicit-upload-only' : 'disabled', automaticUpload: false, accountValidation: 'unverified', attemptedPayloads: attempts.size }) });
}
