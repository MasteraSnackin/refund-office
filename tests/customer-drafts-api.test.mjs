import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createRuntimeApiServer } from '../server/runtime-api.mjs';
import { createRuntimeSessions } from '../server/runtime-auth.mjs';
import { createHostedHandler } from '../server/hosted-api.mjs';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { buildCustomerClarificationDraft } from '../server/customer-drafts.mjs';
import { draftPacket } from './customer-drafts/fixtures.mjs';

const tenantId = '00000000-0000-4000-8000-000000000012';
const userId = '40000000-0000-4000-8000-000000000001';
const runId = '62000000-0000-4000-8000-000000000012';
const workspace = packet => ({ tenantId, mode: 'synthetic-only', paymentsEnabled: false, cases: [structuredClone(packet.case)], orders: [structuredClone(packet.order)], policy: { version: 1, limitMinor: 5000 }, intakeRequests: [] });

async function local(t, { bound = false, failRead = false } = {}) {
  const packet = draftPacket(), calls = [], auth = createRuntimeSessions({ tenantId }); let switching = false;
  const server = createRuntimeApiServer({ auth, service: { customerDraft: async (who, id) => {
    calls.push({ who, id }); if (failRead) throw Error('Private source details'); return buildCustomerClarificationDraft(packet);
  } }, ...(bound ? { demoControl: { describe: () => ({ id: runId }), blocked: () => switching } } : {}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auth.close(); });
  async function call(path, { method = 'GET', body, cookie, fence = bound ? runId : undefined } = {}) {
    const headers = { Host: '127.0.0.1:4274', Origin: 'http://127.0.0.1:4273', ...(cookie ? { Cookie: cookie } : {}), ...(fence !== undefined && fence !== null ? { 'X-Refund-Demo-Run': fence } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}) };
    return await new Promise((resolve, reject) => { const request = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, { method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }); });
    }); request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body)); });
  }
  return { packet, calls, call, switching(value) { switching = value; }, async login(role) { const response = await call('/api/session', { method: 'POST', body: { profileId: role } }); assert.equal(response.status, 200); return response.headers['set-cookie'][0].split(';')[0]; } };
}

test('local draft route is authenticated and read-only for both rehearsal roles', async t => {
  const fixture = await local(t), before = structuredClone(fixture.packet);
  assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft')).status, 401); assert.equal(fixture.calls.length, 0);
  for (const role of ['reviewer', 'investigator']) {
    const cookie = await fixture.login(role), response = await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie });
    assert.equal(response.status, 200); assert.equal(response.json().eligible, true); assert.equal(response.json().unsent, true);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(fixture.calls.at(-1).who.role, role);
    const count = fixture.calls.length;
    for (const method of ['POST', 'DELETE']) assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { method, body: {}, cookie })).status, 405);
    assert.equal(fixture.calls.length, count);
  }
  assert.deepEqual(fixture.packet, before);
});

test('reset-enabled draft reads require the current run and refuse switching before reading saved records', async t => {
  const fixture = await local(t, { bound: true }), cookie = await fixture.login('reviewer');
  for (const fence of [null, '62000000-0000-4000-8000-000000000099']) {
    assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie, fence })).status, 409);
  }
  assert.equal(fixture.calls.length, 0); fixture.switching(true);
  assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie })).status, 503); assert.equal(fixture.calls.length, 0);
  fixture.switching(false); assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie })).status, 200);
});

test('draft read failures redact saved source details and do not report a sent message', async t => {
  const fixture = await local(t, { failRead: true }), cookie = await fixture.login('reviewer');
  const response = await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie }); assert.equal(response.status, 500); assert.doesNotMatch(response.text, /Private source|sent.*true/);
});

const origin = 'https://customer-draft-fixture.invalid';
function hosted({ role = 'reviewer', offline = false } = {}) {
  const env = offline ? { REFUND_OFFICE_NETWORK: 'offline' } : { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_HOSTED: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime', REFUND_OFFICE_PUBLIC_ORIGIN: origin, REFUND_OFFICE_HOSTED_TENANT_ID: tenantId,
    SUPABASE_URL: 'https://customer-draft-fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', REFUND_OFFICE_SESSION_SECRET: Buffer.alloc(32, 3).toString('base64url') };
  const packet = draftPacket(), calls = [], sessions = new Map();
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.fixture-signature`;
  const context = { tenantId, userId, role, title: 'Synthetic draft fixture', synthetic: true };
  const handler = createHostedHandler({ env, fetchImpl: async (url, init) => {
    assert.equal(offline, false, 'Offline mode must not reach even the injected transport'); assert.equal(new URL(url).hostname, 'customer-draft-fixture.supabase.co');
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; calls.push({ path, body });
    if (path === '/auth/v1/token') return Response.json({ access_token: token, refresh_token: 'fixture-refresh' });
    if (path === '/auth/v1/user') return Response.json({ id: userId, is_anonymous: false });
    if (path.endsWith('/refund_runtime_session_context')) return Response.json(context);
    if (path.endsWith('/refund_runtime_hosted_session')) {
      if (body.p_action === 'create') sessions.set(body.p_session_id, { ...context, sessionId: body.p_session_id, generation: 1, sessionExpiresAt: new Date(Date.now() + 86400000).toISOString(), revoked: false });
      const row = sessions.get(body.p_session_id); assert.ok(row); return Response.json(row);
    }
    if (path.endsWith('/refund_runtime_read_workspace')) return Response.json(workspace(packet));
    assert.fail(`A draft must not call a provider or mutate workflow: ${path}`);
  } });
  const call = (path, { method = 'GET', body, cookie, requestOrigin } = {}) => handler(new Request(origin + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', origin } : {}), ...(cookie ? { cookie } : {}), ...(requestOrigin !== undefined ? { origin: requestOrigin } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
  return { packet, calls, call, async login() { const response = await call('/api/session', { method: 'POST', body: { email: 'fixture@example.invalid', password: 'fictional-password' } }); assert.equal(response.status, 200, await response.clone().text()); return response.headers.get('set-cookie').split(';')[0]; } };
}

test('prepared hosted draft stays disconnected without credentials, transport or request access', async () => {
  const fixture = hosted({ offline: true }); assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft')).status, 503); assert.equal(fixture.calls.length, 0);
});

for (const role of ['reviewer', 'investigator']) test(`prepared hosted ${role} draft uses verified session and one read without provider or workflow writes`, async () => {
  const fixture = hosted({ role }), before = structuredClone(fixture.packet);
  assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft')).status, 401); assert.equal(fixture.calls.length, 0);
  const cookie = await fixture.login(), start = fixture.calls.length;
  const response = await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie }), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.eligible, true); assert.equal(body.unsent, true); assert.equal(body.id, fixture.packet.case.id); assert.equal(body.caseId, fixture.packet.case.caseId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(fixture.calls.slice(start).map(call => call.path.split('/').at(-1)), ['user', 'refund_runtime_hosted_session', 'refund_runtime_read_workspace']);
  assert.deepEqual(fixture.packet, before);
  const reads = fixture.calls.filter(call => call.path.endsWith('/refund_runtime_read_workspace')).length;
  assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { method: 'POST', body: {}, cookie })).status, 405);
  assert.equal((await fixture.call('/api/cases/SYN-C1/customer-draft', { cookie, requestOrigin: 'https://foreign.invalid' })).status, 403);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/refund_runtime_read_workspace')).length, reads);
});

test('runtime service builds drafts for both valid roles from a current read and denies unauthenticated callers', async t => {
  const packet = draftPacket(), before = structuredClone(packet), calls = [];
  const repo = { async readWorkspace() { calls.push('read'); return workspace(packet); } };
  const service = createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, automaticWorker: false }); t.after(() => service.close());
  await assert.rejects(service.customerDraft(null, packet.case.id), { status: 401 }); assert.deepEqual(calls, []);
  for (const role of ['reviewer', 'investigator']) {
    const first = await service.customerDraft({ tenantId, userId, role }, packet.case.id); assert.equal(first.eligible, true);
    packet.case.revision++; const next = await service.customerDraft({ tenantId, userId, role }, packet.case.id); assert.equal(next.revision, first.revision + 1);
  }
  assert.deepEqual(packet.case.evidence, before.case.evidence); assert.equal(calls.length, 4);
});
