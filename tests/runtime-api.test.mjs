import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createRuntimeApiServer } from '../server/runtime-api.mjs';
import { createRuntimeSessions } from '../server/runtime-auth.mjs';
const tenantId = '00000000-0000-4000-8000-000000000012';
async function fixture(t, overrides = {}, integrations = {}) {
  let now = 1_800_000_000_000; const calls = [];
  const auth = createRuntimeSessions({ tenantId, now: () => now, ttlMs: 1000 });
  const service = { bootstrap: async principal => { calls.push(principal); return { cases: [], role: principal.role }; },
    intake: async (_principal, input) => ({ replayed: false, input }), approve: async () => ({}), report: async () => ({ filename: 'RF-1.md', text: '# Report\n\nNot paid.' }), ...overrides };
  const server = createRuntimeApiServer({ service, auth, ...integrations }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auth.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, headers = {}, cookie, origin = 'http://127.0.0.1:4273' } = {}) {
    return new Promise((resolve, reject) => { const req = httpRequest(base + path, { method, headers: { Host: '127.0.0.1:4274', ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: { get: name => { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value || null; } }, text: async () => text, json: async () => JSON.parse(text) }); }); }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body)); });
  }
  const login = async role => { const response = await request('/api/session', { method: 'POST', body: { profileId: role } }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; };
  return { request, login, calls, expire() { now += 1001; } };
}

test('all mutations including profile entry reject missing/foreign origins and nonlocal Host', async t => {
  const f = await fixture(t);
  for (const origin of [null, 'https://untrusted.example']) assert.equal((await f.request('/api/session', { method: 'POST', body: { profileId: 'reviewer' }, origin })).status, 403);
  assert.equal((await f.request('/api/session', { headers: { Host: 'untrusted.example' } })).status, 403);
  assert.equal((await f.request('/api/session', { method: 'POST', body: { profileId: 'reviewer' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/session', { method: 'POST', body: { profileId: 'reviewer', data: 'x'.repeat(17000) } })).status, 413);
});
test('cookie session gates cases, expires, and logout revokes access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bootstrap')).status, 401);
  const cookie = await f.login('reviewer');
  assert.equal((await f.request('/api/bootstrap', { cookie })).status, 200); assert.equal(f.calls[0].role, 'reviewer');
  f.expire(); assert.equal((await f.request('/api/bootstrap', { cookie })).status, 401);
  const next = await f.login('investigator');
  assert.equal((await f.request('/api/session', { method: 'DELETE', body: {}, cookie: next })).status, 200);
  assert.equal((await f.request('/api/bootstrap', { cookie: next })).status, 401);
});
test('profile entry rejects caller-supplied identities and no payment routes exist', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/session', { method: 'POST', body: { profileId: 'reviewer', userId: 'forged' } })).status, 400);
  const cookie = await f.login('reviewer');
  for (const action of ['advance', 'reconcile', 'run', 'submit-payment']) assert.equal((await f.request('/api/cases/SYN-C1/' + action, { method: 'POST', body: {}, cookie })).status, 404);
  assert.equal((await f.request('/api/policy', { method: 'PATCH', body: {}, cookie })).status, 404);
});
test('error responses redact provider/database details and preserve uncertain write identity', async t => {
  const f = await fixture(t, { approve: async () => { throw Object.assign(new Error('secret-data-from-database'), { code: 'runtime_transport_unresolved', uncertain: true }); } });
  const cookie = await f.login('reviewer'); const response = await f.request('/api/cases/SYN-C1/approve', { method: 'POST', body: {}, cookie });
  assert.equal(response.status, 503); const result = await response.json(); assert.equal(result.error.uncertain, true); assert.doesNotMatch(JSON.stringify(result), /secret-data/);
});
test('report downloads remain authenticated plain text and non-cacheable', async t => {
  const f = await fixture(t); const cookie = await f.login('reviewer');
  const response = await f.request('/api/cases/SYN-C1/report', { cookie }); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/markdown/); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(await response.text(), /Not paid/);
});
test('sponsor routes retain session and origin protection and distinguish MP3 from JSON', async t => {
  const calls = [];
  const f = await fixture(t, {}, { sponsorActions: {
    status: async (who, id) => { calls.push(['status', who.role, id]); return { mode: 'offline' }; },
    generateVoice: async (who, id, body) => { calls.push(['voice', who.role, id, body]); return { contentType: 'audio/mpeg', bytes: Buffer.from('ID3\x04fixture') }; },
    readMiro: async (who, id, body) => { calls.push(['read', who.role, id, body]); return { verified: false }; },
  } });
  assert.equal((await f.request('/api/cases/C1/sponsor-actions/status')).status, 401);
  const cookie = await f.login('reviewer');
  assert.equal((await f.request('/api/cases/C1/sponsor-actions/status', { cookie })).status, 200);
  assert.equal((await f.request('/api/cases/C1/sponsor-actions/voice', { method: 'POST', body: {}, cookie, origin: null })).status, 403);
  assert.equal(calls.length, 1);
  const voice = await f.request('/api/cases/C1/sponsor-actions/voice', { method: 'POST', body: { expectedRevision: 3 }, cookie });
  assert.equal(voice.status, 200); assert.equal(voice.headers.get('content-type'), 'audio/mpeg'); assert.equal(voice.headers.get('cache-control'), 'no-store');
  const read = await f.request('/api/cases/C1/sponsor-actions/miro/readback', { method: 'POST', body: { expectedRevision: 3 }, cookie });
  assert.equal(read.status, 200); assert.deepEqual(calls[2], ['read','reviewer','C1',{expectedRevision:3}]);
});
test('advisory routes check session and preserve a stale-case response without exposing internals', async t => {
  let calls = 0;
  const f = await fixture(t, {}, { analysis: { run: async () => { calls++; throw Object.assign(Error('private packet body'), { code: 'analysis_stale_case' }); } } });
  assert.equal((await f.request('/api/cases/C1/analysis', { method: 'POST', body: {} })).status, 401);
  const cookie = await f.login('investigator');
  const result = await f.request('/api/cases/C1/analysis', { method: 'POST', body: { expectedRevision: 2 }, cookie });
  assert.equal(result.status, 409); assert.equal(calls, 1); assert.doesNotMatch(await result.text(), /private packet/);
});
test('ordinary local API exposes neither reset metadata nor a reset route', async t => {
  const f=await fixture(t);const cookie=await f.login('reviewer');
  const session=await f.request('/api/session',{cookie});assert.equal((await session.json()).demoRun,undefined);assert.equal(session.headers.get('x-refund-demo-run'),null);
  const bootstrap=await f.request('/api/bootstrap',{cookie});assert.equal((await bootstrap.json()).capabilities?.demoReset,undefined);
  assert.equal((await f.request('/api/demo/reset',{method:'POST',body:{},cookie})).status,404);
});
