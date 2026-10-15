import { timingSafeEqual } from 'node:crypto';
import { hostedPublicSettings, HostedError } from './hosted-auth.mjs';
import { requireRuntimePaymentGate, createRuntimePaymentExecutor, createRuntimePaymentRepository, createRuntimeStripeTestProvider } from './runtime-payments.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, message, uncertain = false) => { const error = new HostedError(status, code, message); error.uncertain = uncertain; throw error; };
const allowedRpcs = new Set(['authorise_execution','read_execution','payment_authorisation_context','claim_execution','begin_submission','save_refund_reference','note_execution_unknown','claim_reconciliation','record_refund_readback'].map(name => 'refund_runtime_' + name));

function settings(env) {
  // No secret or access token is inspected until both independent gates pass.
  requireRuntimePaymentGate(env);
  const publicConfig = hostedPublicSettings(env);
  let base;
  try { base = new URL(env.SUPABASE_URL); if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname) || base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error(); }
  catch { fail(503, 'payment_configuration_required', 'Configure the intended Supabase project.'); }
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,8000}$/.test(key)) fail(503, 'payment_configuration_required', 'Use the project publishable key, never a privileged service key.');
  return { ...publicConfig, base, key };
}
function claims(token, now) {
  let result;
  try { if (typeof token !== 'string' || token.length > 12000 || /\s/.test(token) || token.split('.').length !== 3) throw Error(); result = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { fail(401, 'payment_session_required', 'A current authenticated user session is required.'); }
  if (!object(result) || result.role !== 'authenticated' || result.is_anonymous === true || !UUID.test(result.sub || '') || !Number.isSafeInteger(result.exp) || result.exp <= now() / 1000) fail(401, 'payment_session_required', 'Use a current non-anonymous user session.');
  return result;
}
async function remote(env, fetchImpl, token, path, body) {
  const config = settings(env), write = body !== undefined && !['refund_runtime_read_execution','refund_runtime_payment_authorisation_context'].some(name => path.endsWith('/' + name));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(new URL(path, config.base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 403 : 503, 'payment_database_unconfirmed', 'The payment operation was not confirmed. Inspect its saved identity before retrying.', write);
    const reader = response.body?.getReader(); if (!reader) throw Error();
    let size = 0; const chunks = [];
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 512 * 1024) { await reader.cancel(); throw Error(); } chunks.push(Buffer.from(item.value)); } }
    finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(result)) throw Error(); return result;
  } catch (error) {
    if (error instanceof HostedError) throw error;
    fail(503, 'payment_database_unconfirmed', 'The payment operation could not be read back. Preserve its original identity.', write);
  } finally { clearTimeout(timer); }
}

export async function authenticatePaymentMachine(request, { env = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const config = settings(env), expected = env.REFUND_OFFICE_PAYMENT_MACHINE_KEY, userId = env.REFUND_OFFICE_PAYMENT_MACHINE_USER_ID;
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(expected) || !UUID.test(userId || '') || expected === env.REFUND_OFFICE_MACHINE_KEY || userId === env.REFUND_OFFICE_MACHINE_USER_ID) fail(503, 'payment_machine_disconnected', 'Configure a separate payment executor identity and secret. Intake credentials cannot execute payments.');
  const supplied = request.headers.get('x-refund-payment-key') || '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail(401, 'payment_machine_denied', 'The payment executor credential was not accepted.');
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '')?.[1], parsed = claims(token, now);
  if (parsed.sub !== userId) fail(403, 'payment_machine_denied', 'Only the configured payment executor can use this route.');
  // Parsing the JWT is not verification. Supabase must independently verify it.
  const user = await remote(env, fetchImpl, token, '/auth/v1/user');
  if (user.id !== userId || user.is_anonymous === true) fail(403, 'payment_machine_denied', 'The payment executor identity could not be verified.');
  // The RPCs subsequently verify this user's actual database membership. The
  // fixed role below is a routing restriction, not a client-supplied grant.
  return { principal: { userId, tenantId: config.tenantId, role: 'payment-executor' }, accessToken: token };
}

export function createHostedPayments({ env = {}, fetchImpl = globalThis.fetch, now = Date.now, principal, accessToken } = {}) {
  const checked = () => {
    const config = settings(env), token = claims(accessToken, now);
    if (!principal || token.sub !== principal.userId || principal.tenantId !== config.tenantId || !['reviewer','payment-executor'].includes(principal.role)) fail(403, 'payment_role_required', 'A reviewer or dedicated payment executor is required.');
    return config;
  };
  const repository = () => {
    const config = checked();
    return createRuntimePaymentRepository({ env, tenantId: config.tenantId, rpc: async (name, body) => {
      checked(); if (!allowedRpcs.has(name) || body.p_tenant_id !== principal.tenantId) fail(403, 'payment_rpc_denied', 'Only the scoped payment workflow is available.');
      return remote(env, fetchImpl, accessToken, `/rest/v1/rpc/${name}`, body);
    } });
  };
  const role = expected => { checked(); if (principal.role !== expected) fail(403, 'payment_role_required', 'This action requires a different payment role.'); };
  return {
    async context(caseId) {
      role('reviewer');
      if (typeof caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(caseId)) fail(400, 'invalid_payment_case', 'Use the saved case identity.');
      return repository().paymentAuthorisationContext(caseId);
    },
    async authorise(body) {
      role('reviewer');
      const allowed = ['operationId','expectedCaseRevision','originalApprovalId','originalFingerprint','expectedAmountMinor','mapping','note','commandId'];
      if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => body[key] === undefined)) fail(400, 'invalid_execution_authorisation', 'Supply the exact saved approval, revision, amount, mapping and decision reason.');
      const repo = repository();
      try {
        const result = await repo.authoriseExecution(body), saved = await repo.readExecution(result.id);
        if (saved.id !== result.id || JSON.stringify(saved.authorisation) !== JSON.stringify(result.authorisation) || saved.payloadDigest !== result.payloadDigest || saved.idempotencyKey !== result.idempotencyKey) throw Error('Unverified saved decision');
        if (saved.operationId !== body.operationId || saved.originalApproval.id !== body.originalApprovalId || saved.authorisation.originalFingerprint !== body.originalFingerprint || saved.authorisation.caseRevision !== body.expectedCaseRevision || saved.payload.amountMinor !== body.expectedAmountMinor || Object.keys(body.mapping || {}).some(key => saved.mapping[key] !== body.mapping[key])) throw Error('Changed authorisation');
        return { execution: saved, authorisationReadbackVerified: true, submitted: Boolean(saved.submittedAt) };
      } catch {
        // A write may have committed even when its response or subsequent read
        // is malformed or lost. Never report a fresh-decision opportunity.
        fail(503, 'execution_authorisation_unconfirmed', 'The execution decision could not be independently verified. Preserve its original command reference and inspect the saved result.', true);
      }
    },
    async read(executionId) { checked(); if (!UUID.test(executionId || '')) fail(400, 'invalid_execution_id', 'Use the saved execution identity.'); const execution = await repository().readExecution(executionId); if (execution.id !== executionId) fail(502, 'execution_readback_mismatch', 'The execution identity was not confirmed.'); return { execution }; },
    async execute(executionId) { role('payment-executor'); return createRuntimePaymentExecutor({ env, repository: repository(), provider: createRuntimeStripeTestProvider({ env, fetchImpl }), now }).execute(executionId); },
    async reconcile(executionId) { role('payment-executor'); return createRuntimePaymentExecutor({ env, repository: repository(), provider: createRuntimeStripeTestProvider({ env, fetchImpl }), now }).reconcile(executionId); },
  };
}
