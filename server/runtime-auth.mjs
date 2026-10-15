import { randomBytes, createHash } from 'node:crypto';

// Fixed fictional identities for the isolated LOCAL rehearsal. These are not
// Supabase accounts, passwords or a production authentication mechanism.
export const LOCAL_RUNTIME_PROFILES = Object.freeze([
  Object.freeze({ id: 'reviewer', label: 'Local reviewer', role: 'reviewer', userId: '40000000-0000-4000-8000-000000000001', description: 'Inspect evidence and record an explicit review decision.' }),
  Object.freeze({ id: 'investigator', label: 'Local investigator', role: 'investigator', userId: '40000000-0000-4000-8000-000000000002', description: 'Follow investigations and submit intake. Cannot approve refunds.' }),
]);
export const LOCAL_RUNTIME_WORKER = Object.freeze({ id: 'background-worker', profileId: 'background-worker', role: 'investigator', userId: '40000000-0000-4000-8000-000000000003' });
const COOKIE = 'refund_runtime_rehearsal';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');

export class RuntimeAuthError extends Error {
  constructor(status, code, message) { super(message); this.name = 'RuntimeAuthError'; this.status = status; this.code = code; }
}

export function createRuntimeSessions({ tenantId, datasetTitle = 'Synthetic workspace', now = Date.now, ttlMs = 30 * 60 * 1000, maxSessions = 32, cookieName = COOKIE } = {}) {
  if (!UUID.test(tenantId || '') || typeof datasetTitle !== 'string' || datasetTitle.length > 160 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000 || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) throw new Error('Invalid local rehearsal session configuration.');
  const sessions = new Map();
  if(!['refund_runtime_rehearsal','refund_evidence_rehearsal'].includes(cookieName))throw new Error('Choose a known isolated rehearsal cookie.');
  const profiles = LOCAL_RUNTIME_PROFILES.map(({ userId: _userId, ...profile }) => profile);
  const workspace = { id: tenantId, title: datasetTitle, store: 'postgresql-local' };
  function cookieToken(request) {
    const header = request?.headers?.cookie;
    if (typeof header !== 'string' || header.length > 8192) return null;
    const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='));
    if (values.length !== 1) return null;
    const token = values[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  }
  function sweep() { const time = now(); for (const [key, value] of sessions) if (value.expiresAtMs <= time) sessions.delete(key); }
  function find(request) { sweep(); const token = cookieToken(request); return token ? sessions.get(hash(token)) || null : null; }
  function publicBody(principal) {
    return { mode: 'local-rehearsal', authenticated: Boolean(principal), profiles: structuredClone(profiles),
      session: principal ? { userId: principal.userId, profileId: principal.profileId, role: principal.role, expiresAt: principal.expiresAt } : null,
      workspace: { ...workspace } };
  }
  function revoke(request) { const token = cookieToken(request); if (token) sessions.delete(hash(token)); }
  function describe(request) { return publicBody(find(request)); }
  return {
    describe,
    authenticate(request) {
      const principal = find(request);
      if (!principal) throw new RuntimeAuthError(401, 'runtime_session_required', 'Your local rehearsal session has ended. Choose a local profile to continue.');
      return { ...principal };
    },
    signIn(request, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'profileId')) throw new RuntimeAuthError(400, 'invalid_local_profile', 'Choose one of the supplied local rehearsal profiles.');
      const profile = LOCAL_RUNTIME_PROFILES.find(item => item.id === input.profileId);
      if (!profile) throw new RuntimeAuthError(400, 'invalid_local_profile', 'Choose one of the supplied local rehearsal profiles.');
      sweep();
      const existing = find(request);
      if (sessions.size >= maxSessions && !existing) throw new RuntimeAuthError(429, 'local_sessions_full', 'The local rehearsal has too many active sessions. Sign out of an existing session before continuing.');
      revoke(request);
      const token = randomBytes(32).toString('hex');
      const expiresAtMs = now() + ttlMs;
      const principal = { profileId: profile.id, userId: profile.userId, role: profile.role, tenantId, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() };
      sessions.set(hash(token), principal);
      return { body: publicBody(principal), cookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${Math.floor(ttlMs / 1000)}` };
    },
    signOut(request) { revoke(request); return { body: publicBody(null), cookie: `${cookieName}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0` }; },
    workerPrincipal() { return { ...LOCAL_RUNTIME_WORKER, tenantId }; },
    close() { sessions.clear(); },
  };
}
