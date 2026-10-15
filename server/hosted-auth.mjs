import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COOKIE = '__Host-refund_office';
const MAX_RESPONSE = 128 * 1024;
export class HostedError extends Error {
  constructor(status, code, message) { super(message); this.name = 'HostedError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HostedError(status, code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function requireHostedEnabled(env) {
  if (env.REFUND_OFFICE_NETWORK !== 'enabled' || env.REFUND_OFFICE_WORKING_STORE !== 'supabase' ||
    !String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(s => s.trim()).includes('supabase-runtime') || env.REFUND_OFFICE_HOSTED !== 'enabled') {
    fail(503, 'hosted_disconnected', 'The hosted application is disconnected. No account or provider was contacted.');
  }
}
export function hostedPublicSettings(env) {
  requireHostedEnabled(env);
  let origin;
  try { const value = new URL(env.REFUND_OFFICE_PUBLIC_ORIGIN); if (value.protocol !== 'https:' || value.username || value.password || value.port || value.pathname !== '/' || value.search || value.hash) throw new Error(); origin = value.origin; } catch { fail(503, 'hosted_configuration_required', 'Set the intended HTTPS application origin.'); }
  if (!UUID.test(env.REFUND_OFFICE_HOSTED_TENANT_ID || '')) fail(503, 'hosted_configuration_required', 'Set the intended synthetic tenant.');
  return { origin, tenantId: env.REFUND_OFFICE_HOSTED_TENANT_ID };
}
function tokenClaims(token, now, allowExpired = false) {
  let claims;
  try { if (typeof token !== 'string' || token.length > 12000 || /\s/.test(token) || token.split('.').length !== 3) throw new Error(); claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { fail(401, 'hosted_session_required', 'Sign in with a current user session.'); }
  if (!object(claims) || claims.role !== 'authenticated' || claims.is_anonymous === true || !UUID.test(claims.sub || '') || !Number.isSafeInteger(claims.exp) || (!allowExpired && claims.exp <= now() / 1000)) fail(401, 'hosted_session_required', 'Sign in with a current non-anonymous user session.');
  return claims;
}
async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('size');
  const reader = response.body?.getReader(); if (!reader) throw new Error('body');
  const chunks = []; let total = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_RESPONSE) { await reader.cancel(); throw new Error('size'); } chunks.push(Buffer.from(value)); } return JSON.parse(Buffer.concat(chunks)); }
  finally { reader.releaseLock(); }
}
export function createHostedAuth({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  function settings() {
    const publicSettings = hostedPublicSettings(env); let base;
    try { base = new URL(env.SUPABASE_URL); if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(base.hostname) || base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error(); } catch { fail(503, 'hosted_configuration_required', 'Set a standard HTTPS Supabase project origin.'); }
    const key = env.SUPABASE_PUBLISHABLE_KEY;
    // This boundary intentionally accepts only the modern public-key format.
    if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || key.length > 8192) fail(503, 'hosted_configuration_required', 'A Supabase publishable key is required.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) fail(503, 'hosted_configuration_required', 'Use a bounded request timeout.');
    return { ...publicSettings, base, key };
  }
  async function call(path, { token, body, empty = false } = {}) {
    const config = settings(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, config.base), { method: body === undefined && !empty ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) fail(response.status === 401 || response.status === 403 || response.status === 400 ? 401 : 502, 'hosted_auth_rejected', 'The account, session or workspace access could not be verified.');
      if (empty) return null;
      let result; try { result = await responseJson(response); } catch { fail(502, 'hosted_auth_unverified', 'The account service returned an unverified response.'); }
      if (!object(result)) fail(502, 'hosted_auth_unverified', 'The account service returned an unverified response.');
      return result;
    } catch (error) { if (error instanceof HostedError) throw error; fail(502, 'hosted_auth_unavailable', 'The account service could not be reached. No result is confirmed.'); }
    finally { clearTimeout(timer); }
  }
  function secret(config) {
    const encoded = env.REFUND_OFFICE_SESSION_SECRET;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) fail(503, 'hosted_configuration_required', 'Configure a separate 32-byte session encryption secret.');
    const key = Buffer.from(encoded, 'base64url'); if (key.length !== 32 || key.toString('base64url') !== encoded) fail(503, 'hosted_configuration_required', 'Configure a valid session encryption secret.');
    return { key, aad: Buffer.from(`refund-office|${config.origin}|${config.tenantId}`) };
  }
  function seal(session) {
    const config = settings(), { key, aad } = secret(config), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const encoded = Buffer.concat([iv, cipher.update(JSON.stringify(session)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    if (encoded.length > 3700) fail(502, 'hosted_session_too_large', 'The returned session exceeds the supported cookie size.');
    return `${COOKIE}=${encoded}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((session.sessionExpiresAt - now()) / 1000))}`;
  }
  const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  function open(request) {
    const config = settings(), { key, aad } = secret(config), header = request.headers.get('cookie') || '';
    if (header.length > 8192) fail(401, 'hosted_session_required', 'Sign in again.');
    const entries = header.split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
    if (entries.length !== 1) fail(401, 'hosted_session_required', 'Sign in to continue.');
    let value;
    try {
      const encoded = entries[0].slice(COOKIE.length + 1); if (!/^[A-Za-z0-9_-]{60,3700}$/.test(encoded)) throw new Error();
      const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
      value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]));
    } catch { fail(401, 'hosted_session_required', 'The session is invalid. Sign in again.'); }
    if (!object(value) || value.tenantId !== config.tenantId || !UUID.test(value.sessionId || '') || !UUID.test(value.userId || '') || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isFinite(value.sessionExpiresAt) || value.sessionExpiresAt <= now()) fail(401, 'hosted_session_required', 'The session has expired. Sign in again.');
    return value;
  }
  async function verifiedUser(token) {
    const claims = tokenClaims(token, now), user = await call('/auth/v1/user', { token });
    if (user.id !== claims.sub || user.is_anonymous === true) fail(401, 'hosted_session_required', 'The signed-in user could not be verified.');
    return { userId: user.id, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }
  function context(value, user) {
    const config = settings();
    if (value.userId !== user.userId || value.tenantId !== config.tenantId || !['reviewer', 'investigator'].includes(value.role) || value.synthetic !== true || typeof value.title !== 'string' || value.title.length > 160) fail(403, 'hosted_membership_required', 'This user has no verified role in the selected synthetic workspace.');
    return { ...user, tenantId: value.tenantId, role: value.role, profileId: user.userId, title: value.title };
  }
  async function sessionCall(token, user, session, action) {
    const config = settings();
    const value = await call('/rest/v1/rpc/refund_runtime_hosted_session', { token, body: { p_tenant_id: config.tenantId, p_session_id: session.sessionId, p_action: action, p_generation: session.generation } });
    const principal = context(value, user), expected = session.generation + (action === 'rotate' ? 1 : 0), expires = Date.parse(value.sessionExpiresAt);
    const generationValid = action === 'revoke' ? Number.isSafeInteger(value.generation) && value.generation >= expected : value.generation === expected;
    if (value.sessionId !== session.sessionId || !generationValid || value.revoked !== (action === 'revoke') || !Number.isFinite(expires) || expires <= now() || expires > now() + 8 * 86400000) fail(401, 'hosted_session_unverified', 'The durable session state could not be verified.');
    return { principal, session: { ...session, generation: value.generation, sessionExpiresAt: expires } };
  }
  const body = principal => ({ mode: 'hosted-supabase', authenticated: Boolean(principal), passwordSignIn: true, session: principal ? { userId: principal.userId, profileId: principal.userId, role: principal.role, expiresAt: principal.expiresAt } : null,
    workspace: { id: hostedPublicSettings(env).tenantId, title: principal?.title || 'Synthetic workspace', store: 'supabase' } });
  const active = saved => { if (saved.revocationOnly === true) fail(401, 'hosted_logout_pending', 'Ending this session has not been confirmed. Retry End session before signing in or using the workspace.'); return saved; };
  const usableRefresh = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/\s/.test(value);
  async function begin(tokens, existing) {
    if (!usableRefresh(tokens.refresh_token)) fail(502, 'hosted_auth_unverified', 'The account service did not return a usable session.');
    const user = await verifiedUser(tokens.access_token), config = settings();
    if (existing && existing.userId !== user.userId) fail(401, 'hosted_session_unverified', 'The refreshed session changed user identity.');
    const candidate = { tenantId: config.tenantId, userId: user.userId, sessionId: existing?.sessionId || randomUUID(), generation: existing?.generation || 1,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
    const checked = await sessionCall(tokens.access_token, user, candidate, existing ? 'rotate' : 'create');
    return { cookie: seal(checked.session), body: body(checked.principal) };
  }
  return {
    publicBody: body,
    async signIn(input, request) {
      const config = settings(); secret(config);
      if (request) {
        let existing; try { existing = open(request); } catch (error) { if (error.status !== 401) throw error; }
        if (existing) active(existing);
      }
      if (!object(input) || Object.keys(input).some(k => !['email', 'password'].includes(k)) || typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254 || typeof input.password !== 'string' || !input.password.length || input.password.length > 1024) fail(400, 'hosted_sign_in_invalid', 'Provide an email address and password.');
      return begin(await call('/auth/v1/token?grant_type=password', { body: { email: input.email.trim(), password: input.password } }));
    },
    async authenticate(request) {
      const saved = active(open(request)), user = await verifiedUser(saved.accessToken);
      if (user.userId !== saved.userId) fail(401, 'hosted_session_required', 'The session identity changed.');
      const checked = await sessionCall(saved.accessToken, user, saved, 'check');
      return { principal: checked.principal, accessToken: saved.accessToken };
    },
    async refresh(request) { const saved = active(open(request)); tokenClaims(saved.accessToken, now, true); return begin(await call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: saved.refreshToken } }), saved); },
    async signOut(request) {
      requireHostedEnabled(env); let durableRevocationConfirmed = false, providerRevocationConfirmed = false, saved;
      try { saved = open(request); } catch (error) { if (error.status !== 401) throw error; }
      try {
        if (!saved) throw new Error('No usable application session');
        const claims = tokenClaims(saved.accessToken, now, true);
        if (claims.sub !== saved.userId) throw new Error('Session identity mismatch');
        if (claims.exp <= now() / 1000) {
          if (!usableRefresh(saved.refreshToken)) throw new Error('No refresh token');
          const tokens = await call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: saved.refreshToken } });
          if (!usableRefresh(tokens.refresh_token) || tokenClaims(tokens.access_token, now).sub !== saved.userId) throw new Error('Unverified refresh');
          // This refresh is solely for revocation. It never rotates or creates
          // a durable application session and cannot restore workspace access.
          saved = { ...saved, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, revocationOnly: true };
        }
        const user = await verifiedUser(saved.accessToken);
        if (user.userId !== saved.userId) throw new Error('Session identity mismatch');
        await sessionCall(saved.accessToken, user, saved, 'revoke'); durableRevocationConfirmed = true;
        await call('/auth/v1/logout?scope=local', { token: saved.accessToken, empty: true }); providerRevocationConfirmed = true;
      } catch { /* Preserve only the ability to retry an unconfirmed revocation. */ }
      const logoutPending = Boolean(saved && !durableRevocationConfirmed);
      return { cookie: logoutPending ? seal({ ...saved, revocationOnly: true }) : clearCookie(), body: { ...body(null), logoutPending, durableRevocationConfirmed, providerRevocationConfirmed } };
    },
    async machine(request) {
      const config = settings(), expected = env.REFUND_OFFICE_MACHINE_KEY, actor = env.REFUND_OFFICE_MACHINE_USER_ID;
      if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(expected) || !UUID.test(actor || '')) fail(503, 'hosted_machine_disconnected', 'The machine investigation hook is disconnected.');
      const supplied = request.headers.get('x-refund-machine-key') || '';
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail(401, 'hosted_machine_denied', 'The machine credential was not accepted.');
      const bearer = request.headers.get('authorization') || '', match = /^Bearer (\S+)$/.exec(bearer);
      const user = await verifiedUser(match?.[1]);
      if (user.userId !== actor) fail(403, 'hosted_machine_denied', 'Only the configured investigator can use this hook.');
      const value = await call('/rest/v1/rpc/refund_runtime_session_context', { token: match[1], body: { p_tenant_id: config.tenantId } });
      const principal = context(value, user); if (principal.role !== 'investigator') fail(403, 'hosted_machine_denied', 'The hook requires the investigator role.');
      return { principal, accessToken: match[1] };
    },
  };
}
