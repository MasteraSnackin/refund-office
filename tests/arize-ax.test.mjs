import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalObserver } from '../server/observability.mjs';
import { ARIZE_ENDPOINTS, createArizeExporter, prepareArizeExport } from '../server/arize-ax.mjs';

async function fixture() {
  const observer = createLocalObserver();
  await observer.span('refund.investigation', { synthetic: true, provider: 'local', 'span.kind': 'CHAIN' }, async () => {
    await observer.span('refund.policy', { synthetic: true, 'span.kind': 'TOOL', 'checks.passed': 2 }, () => true);
  });
  const snapshot = observer.snapshot();
  return { snapshot, selectedSpanIds: snapshot.spans.map(span => span.spanId), projectName: 'refund-office-synthetic', region: 'eu' };
}
const reply = (bytes = Buffer.alloc(0), status = 200, contentType = 'application/x-protobuf') => new Response(bytes, { status, headers: { 'content-type': contentType } });
const configuration = transport => ({ networkEnabled: true, uploadEnabled: true, apiKey: 'test-fixture-api-key', spaceId: 'fixture-space', projectName: 'refund-office-synthetic', region: 'eu', transport });
const confirmation = prepared => ({ selectionConfirmed: true, expectedSha256: prepared.sha256 });
const copy = value => JSON.parse(JSON.stringify(value));

// Independent wire inspection verifies the public OTLP field numbers/types.
function inspect(bytes) {
  let offset = 0; const result = [];
  const int = () => { let value = 0n, shift = 0n; while (true) { const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift; if (byte < 128) return value; shift += 7n; } };
  while (offset < bytes.length) {
    const tag = Number(int()), field = tag >> 3, type = tag & 7;
    if (type === 0) result.push({ field, type, value: int() });
    else if (type === 1) { result.push({ field, type, value: bytes.readBigUInt64LE(offset) }); offset += 8; }
    else if (type === 2) { const length = Number(int()); result.push({ field, type, value: bytes.subarray(offset, offset + length) }); offset += length; }
    else throw Error('Unexpected fixture wire type');
  }
  return result;
}

test('pure preparation produces standard OTLP protobuf with real span hierarchy and no invented LLM data', async () => {
  const inputs = await fixture(), prepared = prepareArizeExport(inputs);
  assert.equal(prepared.accountValidation, 'unverified'); assert.equal(prepared.endpoint, ARIZE_ENDPOINTS.eu);
  const body = Buffer.from(prepared.bodyBase64, 'base64');
  assert.equal(body.length, prepared.byteLength);
  const request = inspect(body); assert.equal(request[0].field, 1);
  const resourceSpans = inspect(request[0].value), scopeSpans = inspect(resourceSpans.find(field => field.field === 2).value);
  const spans = scopeSpans.filter(field => field.field === 2).map(field => inspect(field.value));
  assert.equal(spans.length, 2);
  const child = inputs.snapshot.spans[0];
  assert.equal(spans[0].find(field => field.field === 1).value.toString('hex'), child.traceId);
  assert.equal(spans[0].find(field => field.field === 2).value.toString('hex'), child.spanId);
  assert.equal(spans[0].find(field => field.field === 4).value.toString('hex'), child.parentSpanId);
  assert.equal(spans[0].find(field => field.field === 7).value, BigInt(child.startTimeUnixNano));
  assert.match(body.toString('utf8'), /openinference\.span\.kind/);
  assert.match(body.toString('utf8'), /openinference\.project\.name/);
  assert.doesNotMatch(body.toString('utf8'), /LLM|prompt|completion|token_count/);
});

test('explicit bounded synthetic selections are required and missing parents are disclosed', async () => {
  const inputs = await fixture();
  for (const selectedSpanIds of [undefined, [], ['unknown'], [...inputs.selectedSpanIds, inputs.selectedSpanIds[0]], Array(513).fill('a'.repeat(16))]) {
    assert.throws(() => prepareArizeExport({ ...inputs, selectedSpanIds }));
  }
  const partial = prepareArizeExport({ ...inputs, selectedSpanIds: [inputs.selectedSpanIds[0]] });
  assert.equal(partial.spanCount, 1); assert.equal(partial.missingParentSpans, 1);
  for (const mutation of [span => { span.attributes.synthetic = false; }, span => { span.attributes.complaint = 'private'; }, span => { span.name = 'private'; }, span => { span.kind = 'LLM'; }, span => { span.parentSpanId = span.spanId; }, span => { span.endTimeUnixNano = '1'; }]) {
    const bad = copy(inputs); mutation(bad.snapshot.spans[0]); assert.throws(() => prepareArizeExport(bad));
  }
  assert.throws(() => prepareArizeExport({ ...inputs, region: 'https://unknown.test' }));
});

test('ambient keys and either single opt-in never make a request', async t => {
  const original = process.env.ARIZE_API_KEY; process.env.ARIZE_API_KEY = 'ambient-key';
  t.after(() => { if (original === undefined) delete process.env.ARIZE_API_KEY; else process.env.ARIZE_API_KEY = original; });
  const prepared = prepareArizeExport(await fixture()); let calls = 0;
  for (const flags of [{}, { networkEnabled: true }, { uploadEnabled: true }, { networkEnabled: 'true', uploadEnabled: 'true' }]) {
    const exporter = createArizeExporter({ ...flags, transport: () => { calls++; throw Error('network forbidden'); } });
    assert.equal((await exporter.upload(prepared, confirmation(prepared))).status, 'disabled');
    assert.equal(exporter.status().automaticUpload, false);
  }
  assert.equal(calls, 0);
});

test('configuration, exact selection confirmation and immutable prepared content are checked before transport', async () => {
  const prepared = prepareArizeExport(await fixture()); let calls = 0;
  const transport = () => { calls++; return reply(); };
  const exporter = createArizeExporter(configuration(transport));
  await assert.rejects(exporter.upload(prepared));
  await assert.rejects(exporter.upload(prepared, { selectionConfirmed: true, expectedSha256: 'wrong' }));
  for (const altered of [{ ...prepared, endpoint: 'https://attacker.test' }, { ...prepared, bodyBase64: Buffer.from('private').toString('base64') }, { ...prepared, syntheticOnly: false }]) {
    await assert.rejects(exporter.upload(altered, confirmation(altered)));
  }
  for (const missing of ['apiKey', 'spaceId', 'projectName', 'region']) {
    const config = configuration(transport); delete config[missing];
    await assert.rejects(createArizeExporter(config).upload(prepared, confirmation(prepared)));
  }
  assert.equal(calls, 0);
});

test('explicit upload uses fixed regional HTTPS, current official headers, no redirects/cookies, and collector-only evidence', async () => {
  const prepared = prepareArizeExport(await fixture()); let request;
  const exporter = createArizeExporter(configuration(async (url, init) => { request = { url, init }; return reply(); }));
  const result = await exporter.upload(prepared, confirmation(prepared));
  assert.equal(request.url, ARIZE_ENDPOINTS.eu);
  assert.equal(request.init.headers.authorization, 'test-fixture-api-key');
  assert.equal(request.init.headers['arize-space-id'], 'fixture-space');
  assert.equal(request.init.headers['content-type'], 'application/x-protobuf');
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'omit');
  assert.equal(result.status, 'accepted'); assert.equal(result.acceptedSpans, 2);
  assert.equal(result.evidence, 'collector-response-only'); assert.equal(result.accountValidation, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /test-fixture-api-key|fixture-space/);
});

test('partial OTLP acknowledgement preserves rejected count without leaking provider error text', async () => {
  const prepared = prepareArizeExport(await fixture());
  const message = Buffer.from('SECRET PROVIDER MESSAGE');
  const partial = Buffer.concat([Buffer.from([8, 1, 18, message.length]), message]);
  const exporter = createArizeExporter(configuration(async () => reply(Buffer.concat([Buffer.from([10, partial.length]), partial]))));
  const result = await exporter.upload(prepared, confirmation(prepared));
  assert.equal(result.status, 'partial'); assert.equal(result.acceptedSpans, 1); assert.equal(result.rejectedSpans, 1); assert.equal(result.warning, true);
  assert.equal(result.automaticRetry, false); assert.doesNotMatch(JSON.stringify(result), /SECRET|PROVIDER MESSAGE/);
});

test('lost responses, malformed success and oversized replies remain unresolved and never retry automatically', async () => {
  const prepared = prepareArizeExport(await fixture());
  for (const transport of [
    async () => { throw Error('secret-key-in-network-error'); },
    async () => reply(Buffer.from('not protobuf')),
    async () => reply(Buffer.alloc(0), 200, 'text/html'),
    async () => reply(Buffer.from([10, 2, 8, 3])), // more rejected than sent
    async () => reply(Buffer.from([17, 0, 0, 0, 0, 0, 0, 0, 0])), // unknown fixed64 response field
    async () => reply(Buffer.alloc(65537)),
    async () => reply(Buffer.alloc(0), 503),
  ]) {
    let calls = 0;
    const exporter = createArizeExporter(configuration((...args) => { calls++; return transport(...args); }));
    const result = await exporter.upload(prepared, confirmation(prepared));
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.automaticRetry, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-key/);
    assert.equal((await exporter.upload(prepared, confirmation(prepared))).repeatedAttemptBlocked, true);
    assert.equal(calls, 1);
  }
});

test('concurrent duplicate requests share one attempt and HTTP refusal cannot look successful', async () => {
  const prepared = prepareArizeExport(await fixture()); let calls = 0, release;
  const exporter = createArizeExporter(configuration(async () => { calls++; await new Promise(resolve => { release = resolve; }); return reply(Buffer.alloc(0), 401); }));
  const first = exporter.upload(prepared, confirmation(prepared));
  const duplicate = exporter.upload(prepared, confirmation(prepared));
  release();
  assert.equal((await first).status, 'rejected'); assert.equal((await duplicate).repeatedAttemptBlocked, true); assert.equal(calls, 1);
});

test('an unresponsive injected transport times out as unknown without replaying the selection', async () => {
  const prepared = prepareArizeExport(await fixture()); let calls = 0;
  const exporter = createArizeExporter({ ...configuration(() => { calls++; return new Promise(() => {}); }), timeoutMs: 5 });
  assert.equal((await exporter.upload(prepared, confirmation(prepared))).status, 'unconfirmed');
  assert.equal((await exporter.upload(prepared, confirmation(prepared))).repeatedAttemptBlocked, true);
  assert.equal(calls, 1);
});
