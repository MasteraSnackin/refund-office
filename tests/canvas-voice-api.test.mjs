import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createRuntimeApiServer } from '../server/runtime-api.mjs';
import { RuntimeAuthError } from '../server/runtime-auth.mjs';
import { createHostedHandler } from '../server/hosted-api.mjs';
import { HostedError } from '../server/hosted-auth.mjs';
import { createVercelRuntime } from '../integrations/vercel/api/runtime.mjs';
import { createCanvasVoice, runtimeJsonBodyLimit, VOICE_INPUT_MAX_AUDIO_BYTES, VOICE_INPUT_MAX_BODY_BYTES } from '../server/canvas-voice.mjs';

const tenantId = '00000000-0000-4000-8000-000000000012', userId = '40000000-0000-4000-8000-000000000001';
const principal = { tenantId, userId, role: 'reviewer', profileId: 'reviewer' };
const runId = '62000000-0000-4000-8000-000000000012';
const origin = 'https://voice-fixture.invalid', path = '/api/cases/SYN-C1/voice-input';
const hostedEnv = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_HOSTED: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime', REFUND_OFFICE_PUBLIC_ORIGIN: origin, REFUND_OFFICE_HOSTED_TENANT_ID: tenantId };
const body = (size = 128) => ({ expectedRevision: 7, consent: true, contentType: 'audio/webm;codecs=opus', audioBase64: Buffer.alloc(size, 1).toString('base64') });
const result = { provider: 'elevenlabs', model: 'scribe_v2', text: 'Explain the saved packing record.' };
function fixture({ enabled = true, transcribe, role = 'reviewer' } = {}) {
  const calls = [], packet = { tenantId, case: { id: 'SYN-C1', caseId: 'RF-001', revision: 7, evidence: [{ id: 'packing:SYN-O1', body: 'Saved synthetic evidence' }] }, order: { id: 'SYN-O1' } };
  let active = true, session = { ...principal, role };
  const auth = { authenticate(request) { calls.push('authenticate'); const cookie = request.headers.get ? request.headers.get('cookie') : request.headers.cookie; if (!active || cookie !== 'fixture=session') throw new RuntimeAuthError(401, 'runtime_session_required', 'Sign in.'); return { ...session }; } };
  const service = { exportCase: async (who, id) => { calls.push('read'); assert.deepEqual(who, session); if (id !== packet.case.id) throw new HostedError(403, 'runtime_access_denied', 'Forbidden private record'); return structuredClone(packet); }, close: async () => {}, review: async () => assert.fail('Voice input must not write a review'), approve: async () => assert.fail('Voice input must not approve') };
  const transcription = { capabilities: () => ({ enabled, configured: enabled, retention: 'provider-account-default', privateKey: 'must-never-leak' }), async transcribe(value) { calls.push({ transcription: true, length: value.bytes.length, contentType: value.contentType, signal: value.signal }); return transcribe ? transcribe(value, packet) : { ...result }; } };
  return { calls, packet, auth, service, transcription, revoke() { active = false; }, session(value) { session = value; } };
}
async function local(t, options = {}) {
  const f = fixture(options); let currentRun = runId;
  const server = createRuntimeApiServer({ auth: f.auth, service: f.service, transcription: f.transcription, ...(options.bound ? { demoControl: { describe: () => ({ id: currentRun }), blocked: () => false } } : {}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (route = path, { method = 'GET', value, raw, cookie = 'fixture=session', requestOrigin = 'http://127.0.0.1:4273', host = '127.0.0.1:4274', fence = options.bound ? currentRun : undefined, extra = {}, chunked = false } = {}) => new Promise((resolve, reject) => {
    const text = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const headers = { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(fence ? { 'X-Refund-Demo-Run': fence } : {}), ...(text !== undefined ? { 'Content-Type': 'application/json', ...(!chunked ? { 'Content-Length': Buffer.byteLength(text) } : {}) } : {}), ...extra };
    const request = httpRequest(`http://127.0.0.1:${server.address().port}${route}`, { method, headers }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }); }); });
    request.on('error', reject); request.end(text);
  });
  return { ...f, call, server, setRun(value) { currentRun = value; } };
}
function hosted(options = {}) {
  const f = fixture(options);
  const auth = { async authenticate(request) { try { return { principal: f.auth.authenticate(request), accessToken: 'controlled-test-token' }; } catch (cause) { throw new HostedError(cause.status, cause.code, cause.message); } }, async machine() { assert.fail('Voice input cannot authenticate as a machine'); } };
  const handler = createHostedHandler({ env: hostedEnv, auth, runtimeFactory: () => f.service, transcription: f.transcription, fetchImpl: () => assert.fail('No real transport is allowed') });
  const call = (route = path, { method = 'GET', value, raw, cookie = 'fixture=session', requestOrigin = origin, extra = {}, stream = false, signal } = {}) => {
    const text = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const headers = { ...(cookie ? { cookie } : {}), ...(requestOrigin ? { origin: requestOrigin } : {}), ...(text !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
    const payload = stream && text !== undefined ? new ReadableStream({ start(controller) { const bytes = Buffer.from(text); for (let offset = 0; offset < bytes.length; offset += 4096) controller.enqueue(bytes.subarray(offset, offset + 4096)); controller.close(); } }) : text;
    return handler(new Request(origin + route, { method, headers, ...(payload !== undefined ? { body: payload, duplex: 'half' } : {}), ...(signal ? { signal } : {}) }));
  };
  return { ...f, call, handler };
}
const providerCalls = f => f.calls.filter(value => value?.transcription);

for (const mode of ['local', 'hosted']) {
  const setup = async (t, options) => mode === 'local' ? local(t, options) : hosted(options);
  test(`${mode} voice status and transcription use the saved case revision without writes`, async t => {
    const f = await setup(t), before = structuredClone(f.packet);
    const status = await f.call(), info = mode === 'local' ? status.json() : await status.json();
    assert.equal(status.status, 200); assert.equal(info.caseId, 'SYN-C1'); assert.equal(info.revision, 7); assert.equal(info.available, true); assert.equal(info.maxAudioBytes, VOICE_INPUT_MAX_AUDIO_BYTES); assert.equal(info.maxTextLength, 8000); assert.equal(info.verified, false); assert.equal(info.requiresConsent, true); assert.equal(info.changesSavedCase, false); assert.equal(info.privateKey, undefined);
    const response = await f.call(path, { method: 'POST', value: body(64 * 1024) });
    const data = mode === 'local' ? response.json() : await response.json();
    assert.equal(response.status, 200, JSON.stringify(data)); assert.deepEqual(data, { caseId: 'SYN-C1', revision: 7, ...result });
    assert.equal(providerCalls(f).length, 1); assert.equal(providerCalls(f)[0].contentType, 'audio/webm'); assert.equal(providerCalls(f)[0].length, 64 * 1024); assert.deepEqual(f.packet, before); assert.equal(f.calls.filter(value => value === 'read').length, 3);
  });
  test(`${mode} voice route rejects absent sessions, wrong origin/host and machine credentials before reading`, async t => {
    const f = await setup(t);
    const cases = [{ cookie: null }, { requestOrigin: 'https://foreign.invalid' }, { extra: { authorization: 'Bearer machine-token' } }, { extra: { 'x-refund-machine-key': 'machine-key' } }, mode === 'local' ? { host: 'foreign.invalid' } : { extra: { host: 'foreign.invalid' } }];
    for (const options of cases) { const response = await f.call(path, { method: 'POST', value: body(), ...options }); assert.ok([401, 403].includes(response.status)); }
    assert.equal(f.calls.filter(value => value === 'read').length, 0); assert.equal(providerCalls(f).length, 0);
  });
  test(`${mode} voice route validates consent, fields, MIME and canonical base64 before provider access`, async t => {
    const f = await setup(t);
    for (const change of [{ consent: false }, { consent: 'true' }, { expectedRevision: '7' }, { expectedRevision: 0 }, { userId }, { tenantId }, { amountMinor: 100 }, { contentType: 'text/plain' }, { contentType: 'audio/webm\r\nx-key: secret' }, { audioBase64: '' }, { audioBase64: 'data:audio/webm;base64,YQ==' }, { audioBase64: 'Y Q==' }, { audioBase64: 'YR==' }, { audioBase64: 'YQ===' }]) {
      const response = await f.call(path, { method: 'POST', value: { ...body(), ...change } }); assert.equal(response.status, 400, JSON.stringify(change));
    }
    assert.equal(providerCalls(f).length, 0);
  });
  test(`${mode} voice route rejects stale or inaccessible saved cases and changed facts after transcription`, async t => {
    const f = await setup(t, { transcribe: async (_, packet) => { packet.case.revision++; return { ...result }; } });
    assert.equal((await f.call(path, { method: 'POST', value: { ...body(), expectedRevision: 6 } })).status, 409);
    assert.equal((await f.call('/api/cases/SYN-C2/voice-input', { method: 'POST', value: body() })).status, 403); assert.equal(providerCalls(f).length, 0);
    const response = await f.call(path, { method: 'POST', value: body() }); assert.equal(response.status, 409);
    const text = mode === 'local' ? response.text : await response.text(); assert.doesNotMatch(text, /Explain the saved/); assert.equal(providerCalls(f).length, 1);
  });
  test(`${mode} voice route preserves the offline text fallback and redacts provider failures`, async t => {
    const disconnected = await setup(t, { enabled: false });
    const status = await disconnected.call(), info = mode === 'local' ? status.json() : await status.json(); assert.equal(info.available, false);
    assert.equal((await disconnected.call(path, { method: 'POST', value: body() })).status, 503); assert.equal(providerCalls(disconnected).length, 0);
    const failed = await setup(t, { transcribe: async () => { throw new Error('secret-key private provider response'); } });
    const response = await failed.call(path, { method: 'POST', value: body() }); assert.equal(response.status, 503); assert.doesNotMatch(mode === 'local' ? response.text : await response.text(), /secret-key|private provider/); assert.equal(providerCalls(failed).length, 1);
  });
  test(`${mode} voice-only request limits leave review/session actions at 16KiB`, async t => {
    const f = await setup(t);
    assert.equal((await f.call(path, { method: 'POST', value: body(VOICE_INPUT_MAX_AUDIO_BYTES + 1) })).status, 413);
    const huge = JSON.stringify({ ...body(), audioBase64: 'A'.repeat(VOICE_INPUT_MAX_BODY_BYTES) });
    assert.equal((await f.call(path, { method: 'POST', raw: huge, chunked: true, stream: true })).status, 413);
    assert.equal((await f.call('/api/cases/SYN-C1/review', { method: 'POST', value: { note: 'x'.repeat(17000) }, stream: true, chunked: true })).status, 413);
    assert.equal(providerCalls(f).length, 0);
  });
  test(`${mode} transcription withholds text when the signed-in session is revoked`, async t => {
    let revoke;
    const f = await setup(t, { transcribe: async () => { revoke(); return { ...result }; } }); revoke = f.revoke;
    const response = await f.call(path, { method: 'POST', value: body() }); assert.equal(response.status, 403); assert.doesNotMatch(mode === 'local' ? response.text : await response.text(), /Explain the saved/);
  });
}

test('local voice reads and posts require the current demo run before saved access', async t => {
  const f = await local(t, { bound: true });
  for (const method of ['GET', 'POST']) for (const fence of [null, '62000000-0000-4000-8000-000000000099']) {
    assert.equal((await f.call(path, { method, ...(method === 'POST' ? { value: body() } : {}), fence })).status, 409);
  }
  assert.equal(f.calls.filter(value => value === 'read').length, 0); assert.equal(providerCalls(f).length, 0);
});

test('hosted voice aborts and releases its per-user in-flight guard', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  let count = 0;
  const f = hosted({ transcribe: async ({ signal }) => { count++; if (count > 1) return { ...result }; entered(); return new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('private cancelled recording')), { once: true }); }); } });
  const abort = new AbortController(), first = f.call(path, { method: 'POST', value: body(), signal: abort.signal }); await started;
  assert.equal((await f.call(path, { method: 'POST', value: body() })).status, 409);
  abort.abort(); assert.equal((await first).status, 409);
  assert.equal((await f.call(path, { method: 'POST', value: body() })).status, 200); assert.equal(providerCalls(f).length, 2); release({ ...result });
});

test('local socket cancellation aborts transcription and releases its user guard', async t => {
  let entered, cancelled; let count = 0;
  const started = new Promise(resolve => { entered = resolve; }), aborted = new Promise(resolve => { cancelled = resolve; });
  const f = await local(t, { transcribe: async ({ signal }) => {
    if (++count > 1) return { ...result };
    entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled(); reject(new Error('Private cancelled recording')); }, { once: true }));
  } });
  const text = JSON.stringify(body());
  const request = httpRequest(`http://127.0.0.1:${f.server.address().port}${path}`, { method: 'POST', headers: { Host: '127.0.0.1:4274', Origin: 'http://127.0.0.1:4273', Cookie: 'fixture=session', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } });
  request.on('error', () => {}); request.end(text); await started; request.destroy(); await aborted;
  assert.equal((await f.call(path, { method: 'POST', value: body() })).status, 200); assert.equal(providerCalls(f).length, 2);
});

test('shared voice accepts the exact audio bound and rejects cross-tenant and worker principals', async () => {
  const f = fixture();
  const voice = createCanvasVoice({ getPacket: f.service.exportCase, transcription: f.transcription });
  assert.deepEqual(await voice.transcribe(principal, 'SYN-C1', body(VOICE_INPUT_MAX_AUDIO_BYTES)), { caseId: 'SYN-C1', revision: 7, ...result });
  assert.equal(providerCalls(f)[0].length, VOICE_INPUT_MAX_AUDIO_BYTES);
  f.packet.tenantId = '00000000-0000-4000-8000-000000000099';
  await assert.rejects(voice.status(principal, 'SYN-C1'), { status: 403, code: 'voice_input_access_denied' });
  for (const extra of [{ role: 'administrator' }, { machine: true }, { profileId: 'background-worker' }, { authentication: 'machine' }]) {
    await assert.rejects(voice.status({ ...principal, ...extra }, 'SYN-C1'), { status: 403, code: 'voice_input_access_denied' });
  }
  assert.equal(providerCalls(f).length, 1);
});

test('shared voice bound times out without retrying and rejects invalid returned text', async () => {
  const f = fixture({ transcribe: async () => new Promise(() => {}) });
  const voice = createCanvasVoice({ getPacket: f.service.exportCase, transcription: f.transcription, timeoutMs: 5 });
  await assert.rejects(voice.transcribe(principal, 'SYN-C1', body()), { status: 504, code: 'voice_input_timeout' }); assert.equal(providerCalls(f).length, 1); assert.equal(providerCalls(f)[0].signal.aborted, true);
  for (const value of [{ ...result, text: ' ' }, { ...result, text: 'x'.repeat(8001) }, { ...result, provider: 'other' }, { ...result, model: 'other' }]) {
    const invalid = fixture({ transcribe: async () => value }); const guarded = createCanvasVoice({ getPacket: invalid.service.exportCase, transcription: invalid.transcription });
    await assert.rejects(guarded.transcribe(principal, 'SYN-C1', body()), { status: 502, code: 'voice_input_unverified' });
  }
});

test('shared voice catches changed evidence even when a revision was incorrectly reused', async () => {
  const f = fixture({ transcribe: async (_, packet) => { packet.case.evidence[0].body = 'Changed'; return { ...result }; } });
  const voice = createCanvasVoice({ getPacket: f.service.exportCase, transcription: f.transcription });
  await assert.rejects(voice.transcribe(principal, 'SYN-C1', body()), { status: 409, code: 'voice_input_stale_case' });
});

test('exact body-limit matching never enlarges neighbouring or financial routes', () => {
  assert.equal(runtimeJsonBodyLimit(path, 'POST'), VOICE_INPUT_MAX_BODY_BYTES);
  for (const route of [path + '/', path + '/review', '/api/cases/SYN-C1/review', '/api/cases/SYN-C1/sponsor-actions/voice', '/api/payment-executions', '/api/session', '/api/cases/%53YN-C1/voice-input']) assert.equal(runtimeJsonBodyLimit(route, 'POST'), 16384);
  assert.equal(runtimeJsonBodyLimit(path, 'DELETE'), 16384);
});

async function bridgeCall(route, payload, { streamed = false } = {}) {
  const request = streamed ? Readable.from([Buffer.from(payload.slice(0, 8192)), Buffer.from(payload.slice(8192))]) : { body: payload };
  Object.assign(request, { method: 'POST', url: route, headers: { 'content-type': 'application/json', origin } });
  const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = String(value); } };
  const runtime = createVercelRuntime({ env: hostedEnv, handler: async request => { const text = await request.text(); return Response.json({ length: text.length }); } });
  await runtime(request, response); return response;
}
for (const streamed of [false, true]) test(`Vercel bridge bounds ${streamed ? 'streamed' : 'pre-parsed'} exact voice requests and preserves ordinary limits`, async () => {
  const payload = JSON.stringify(body(64 * 1024));
  assert.equal((await bridgeCall(path, payload, { streamed })).statusCode, 200);
  assert.equal((await bridgeCall('/api/cases/SYN-C1/review', payload, { streamed })).statusCode, 413);
  assert.equal((await bridgeCall('/api/session', payload, { streamed })).statusCode, 413);
  assert.equal((await bridgeCall(path + '/', payload, { streamed })).statusCode, 413);
  assert.equal((await bridgeCall(path, 'x'.repeat(VOICE_INPUT_MAX_BODY_BYTES + 1), { streamed })).statusCode, 413);
});

test('hosted disabled voice handler never uses injected accounts, store or transport', async () => {
  const handler = createHostedHandler({ env: {}, fetchImpl: () => assert.fail('No network'), auth: { authenticate: () => assert.fail('No account') }, runtimeFactory: () => assert.fail('No store') });
  assert.equal((await handler(new Request(origin + path))).status, 503);
});

function bridgeEvents() {
  const request = Object.assign(new EventEmitter(), { body: JSON.stringify(body()), method: 'POST', url: path, headers: { 'content-type': 'application/json', origin } });
  const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = String(value); this.writableEnded = true; this.emit('finish'); this.emit('close'); } });
  return { request, response };
}
for (const event of ['aborted', 'unfinished-close']) test(`Vercel bridge propagates ${event} into the downstream request and removes listeners`, async () => {
  const { request, response } = bridgeEvents(); let entered, captured;
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = createVercelRuntime({ env: hostedEnv, handler: async webRequest => {
    captured = webRequest.signal; entered();
    await new Promise(resolve => captured.addEventListener('abort', resolve, { once: true }));
    return Response.json({ cancelled: true });
  } });
  const running = runtime(request, response); await started;
  assert.equal(captured.aborted, false);
  if (event === 'aborted') request.emit('aborted'); else response.emit('close');
  await running; assert.equal(captured.aborted, true);
  assert.equal(request.listenerCount('aborted'), 0); assert.equal(response.listenerCount('close'), 0);
});

test('Vercel bridge keeps normal request completion and successful response signals live', async () => {
  const { request, response } = bridgeEvents(); let captured;
  const runtime = createVercelRuntime({ env: hostedEnv, handler: async webRequest => {
    captured = webRequest.signal; request.emit('close');
    assert.equal(captured.aborted, false); return Response.json({ complete: true });
  } });
  await runtime(request, response);
  assert.equal(response.statusCode, 200); assert.equal(captured.aborted, false);
  assert.equal(request.listenerCount('aborted'), 0); assert.equal(response.listenerCount('close'), 0);
  request.emit('aborted'); response.writableEnded = false; response.emit('close'); assert.equal(captured.aborted, false);
});
