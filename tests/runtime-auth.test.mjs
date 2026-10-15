import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeSessions, LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER } from '../server/runtime-auth.mjs';
const tenantId = '00000000-0000-4000-8000-000000000012';
const request = cookie => ({ headers: { cookie: cookie?.split(';')[0] } });

test('local access is explicitly a rehearsal and reveals no actor or token before sign-in', () => {
  const sessions = createRuntimeSessions({ tenantId });
  const body = sessions.describe({ headers: {} });
  assert.equal(body.mode, 'local-rehearsal'); assert.equal(body.authenticated, false); assert.equal(body.session, null);
  assert.equal(body.workspace.store, 'postgresql-local');
  assert.deepEqual(body.profiles.map(p => p.id), ['reviewer', 'investigator']);
  assert.ok(body.profiles.every(p => !p.userId && !p.token));
  assert.throws(() => sessions.authenticate({ headers: {} }), { status: 401 });
});

test('a session binds its server-owned role, identity and tenant and uses a restricted cookie', () => {
  const sessions = createRuntimeSessions({ tenantId });
  const result = sessions.signIn({}, { profileId: 'reviewer' });
  assert.match(result.cookie, /HttpOnly; SameSite=Strict; Path=\/api; Max-Age=1800/);
  assert.equal(result.body.authenticated, true); assert.equal(result.body.session.role, 'reviewer');
  const principal = sessions.authenticate(request(result.cookie));
  assert.equal(principal.userId, LOCAL_RUNTIME_PROFILES[0].userId); assert.equal(principal.tenantId, tenantId);
  assert.equal(result.body.userId, undefined); assert.equal(result.body.token, undefined);
  principal.role = 'investigator';
  assert.equal(sessions.authenticate(request(result.cookie)).role, 'reviewer');
});

test('request bodies cannot supply an actor, role, tenant or the background worker identity', () => {
  const sessions = createRuntimeSessions({ tenantId });
  for (const body of [{ profileId: 'reviewer', userId: 'attacker' }, { profileId: 'investigator', role: 'reviewer' }, { profileId: 'reviewer', tenantId }, { profileId: 'background-worker' }, { profileId: 'unknown' }]) assert.throws(() => sessions.signIn({}, body), { status: 400 });
  assert.equal(sessions.workerPrincipal().userId, LOCAL_RUNTIME_WORKER.userId);
  assert.equal(sessions.workerPrincipal().role, 'investigator');
});

test('sessions expire, sign-out revokes access, and restarting a manager grants no previous session', () => {
  let time = 100000;
  const sessions = createRuntimeSessions({ tenantId, now: () => time, ttlMs: 1000 });
  const first = request(sessions.signIn({}, { profileId: 'reviewer' }).cookie);
  time += 1000;
  assert.equal(sessions.describe(first).authenticated, false);
  assert.throws(() => sessions.authenticate(first), { status: 401 });
  const second = request(sessions.signIn({}, { profileId: 'reviewer' }).cookie);
  const logout = sessions.signOut(second);
  assert.match(logout.cookie, /Max-Age=0$/); assert.throws(() => sessions.authenticate(second), { status: 401 });
  assert.throws(() => createRuntimeSessions({ tenantId }).authenticate(second), { status: 401 });
});

test('switching profiles rotates the token and revokes the previous authority', () => {
  const sessions = createRuntimeSessions({ tenantId });
  const first = request(sessions.signIn({}, { profileId: 'reviewer' }).cookie);
  const next = sessions.signIn(first, { profileId: 'investigator' });
  assert.throws(() => sessions.authenticate(first), { status: 401 });
  assert.equal(sessions.authenticate(request(next.cookie)).role, 'investigator');
});

test('malformed, duplicate, forged and excessive cookies do not authenticate', () => {
  const sessions = createRuntimeSessions({ tenantId });
  const cookie = sessions.signIn({}, { profileId: 'reviewer' }).cookie.split(';')[0];
  for (const value of [cookie + '; ' + cookie, 'refund_runtime_rehearsal=' + '0'.repeat(64), 'refund_runtime_rehearsal=short', 'x'.repeat(9000), ['not-a-string']]) assert.throws(() => sessions.authenticate({ headers: { cookie: value } }), { status: 401 });
});

test('local session count is bounded and clearing a manager revokes every session', () => {
  const sessions = createRuntimeSessions({ tenantId, maxSessions: 1 });
  const cookie = sessions.signIn({}, { profileId: 'reviewer' }).cookie;
  assert.throws(() => sessions.signIn({}, { profileId: 'investigator' }), { status: 429 });
  const next = sessions.signIn(request(cookie), { profileId: 'investigator' });
  sessions.close();
  assert.throws(() => sessions.authenticate(request(next.cookie)), { status: 401 });
});
