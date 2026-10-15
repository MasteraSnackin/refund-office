import { hasValidProposalProvenance } from './investigation-proposal.mjs';
import { isDeepStrictEqual } from 'node:util';
// Prepared asynchronous cloud working-store client. The local apps use their
// own SQLite or isolated PostgreSQL transport; neither selects this client.
// All requests require explicit opt-in and a caller-supplied user session.
import { clarificationInput, clarificationContext, verifyClarificationWrite } from './evidence-clarification.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;
const SQL_ERRORS = new Set(['22023', '28000', '42501', '40001', '23505', '23503', '23514', '55000', 'P0001']);

export class RuntimeRepositoryError extends Error {
  constructor(code, message, { uncertain = false } = {}) { super(message); this.name = 'RuntimeRepositoryError'; this.code = code; this.uncertain = uncertain; }
}
const fail = (message) => { throw new RuntimeRepositoryError('invalid_runtime_input', message); };
function id(value, label) { if (typeof value !== 'string' || !LOCAL_ID.test(value)) fail(`${label} is invalid.`); return value; }
function eventIdentity(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) fail('Intake event is invalid.'); return value; }
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`); return value; }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is outside the allowed range.`); return value; }
function text(value, label, min, max) { if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label} is invalid.`); return value.trim(); }
function jwtPayload(token) {
  try { const parts = token.split('.'); if (parts.length !== 3) return null; return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function caseResult(value, expectedId) {
  if (!record(value) || typeof value.id !== 'string' || !LOCAL_ID.test(value.id) || (expectedId && value.id !== expectedId) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new RuntimeRepositoryError('unverified_runtime_response', 'The database returned an unexpected case.');
  return value;
}
async function boundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE) throw new Error('size');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('size'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function createSupabaseRuntimeRepository({ env = process.env, tenantId, getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  // This guard runs before reading a URL, key or access token, even when a
  // developer has credentials in the process environment for another project.
  function requireEnabled() {
    if (env.REFUND_OFFICE_NETWORK !== 'enabled' || env.REFUND_OFFICE_WORKING_STORE !== 'supabase' ||
      !String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(v => v.trim()).includes('supabase-runtime')) {
      throw new RuntimeRepositoryError('runtime_disconnected', 'The Supabase working store is disconnected. The local application keeps its separate storage.');
    }
  }
  async function rpc(name, parameters, write = false) {
    requireEnabled();
    integer(timeoutMs, 'Request timeout', 1, 15000);
    uuid(tenantId, 'Tenant identity');
    let url;
    try { url = new URL(env.SUPABASE_URL); } catch { throw new RuntimeRepositoryError('runtime_configuration_required', 'Provide the intended Supabase project URL.'); }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new RuntimeRepositoryError('runtime_configuration_required', 'Use a standard HTTPS Supabase project origin without a path or embedded credentials.');
    }
    const key = env.SUPABASE_PUBLISHABLE_KEY;
    if (typeof key !== 'string' || !key || key.length > 8192 || /[\r\n]/.test(key) || key.startsWith('sb_secret_') ||
      (!key.startsWith('sb_publishable_') && jwtPayload(key)?.role !== 'anon')) {
      throw new RuntimeRepositoryError('runtime_configuration_required', 'A publishable project key is required. Privileged keys are not accepted.');
    }
    if (typeof getAccessToken !== 'function') throw new RuntimeRepositoryError('reviewer_session_required', 'A signed-in user session is required.');
    let token;
    try { token = await getAccessToken(); } catch { throw new RuntimeRepositoryError('reviewer_session_required', 'The user session could not be obtained.'); }
    const claims = typeof token === 'string' && token.length < 16384 && !/[\r\n]/.test(token) ? jwtPayload(token) : null;
    if (!claims || claims.role !== 'authenticated' || claims.is_anonymous === true || !UUID.test(claims.sub || '') || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000) {
      throw new RuntimeRepositoryError('reviewer_session_required', 'A current, non-anonymous user session is required.');
    }
    // Decoding only rejects obviously unsuitable tokens. Supabase must verify
    // the signature; SQL derives auth.uid() and checks actual tenant membership.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(`/rest/v1/rpc/refund_runtime_${name}`, url), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: key, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...parameters, p_tenant_id: tenantId }),
      });
      let data;
      try { data = await boundedJson(response); }
      catch { throw new RuntimeRepositoryError('unverified_runtime_response', 'The database response could not be verified. Read back the saved identity before retrying a write.', { uncertain: write }); }
      if (!response.ok) {
        const code = record(data) && SQL_ERRORS.has(data.code) ? data.code : null;
        const denied = response.status === 401 || response.status === 403 || code === '42501' || code === '28000';
        throw new RuntimeRepositoryError(denied ? 'runtime_access_denied' : code ? 'runtime_conflict' : 'runtime_request_failed',
          denied ? 'The signed-in user cannot perform this database action.' : code ? 'The database rejected stale, conflicting or invalid input. Refresh the saved record before continuing.' : 'The database request did not return a verified result.',
          { uncertain: write && !code && response.status !== 401 && response.status !== 403 });
      }
      return data;
    } catch (error) {
      if (error instanceof RuntimeRepositoryError) throw error;
      throw new RuntimeRepositoryError('runtime_transport_unresolved', 'The database request could not be confirmed. Retain its original identity and inspect saved state before retrying.', { uncertain: write });
    } finally { clearTimeout(timer); }
  }
  async function readCase(caseId) { requireEnabled(); return caseResult(await rpc('read_case', { p_case_id: id(caseId, 'Case identity') }), caseId); }
  function unexpectedWrite() { throw new RuntimeRepositoryError('unverified_runtime_response', 'The database write response did not match the requested action. Inspect its original identity before retrying.', { uncertain: true }); }
  async function checkedWriteRead(value, expectedId) {
    try { caseResult(value, expectedId); } catch { unexpectedWrite(); }
    const saved = await readCase(value.id).catch(() => unexpectedWrite());
    if (saved.revision < value.revision) unexpectedWrite();
    return saved;
  }
  return {
    async evidenceRequest(caseId) {
      requireEnabled();id(caseId,'Case identity');
      return clarificationContext(await rpc('evidence_request',{p_case_id:caseId}),{tenantId,caseId});
    },
    async submitClarification({caseId,...input}={}) {
      requireEnabled();id(caseId,'Case identity');const clean=clarificationInput(input);
      const value=await rpc('submit_clarification',{p_case_id:caseId,p_input:clean},true);
      return verifyClarificationWrite(value,clean,{tenantId,caseId,readContext:()=>rpc('evidence_request',{p_case_id:caseId}),readCase:()=>readCase(caseId)});
    },
    // No current app code selects this repository. There is deliberately no
    // payment submission or receipt-writing method in this migration phase.
    capabilities() { return { storage: 'supabase-prepared', connected: false, liveVerified: false, paymentSubmission: false, selectedByLocalApp: false }; },
    async readWorkspace() {
      const value = await rpc('read_workspace', {});
      if (!record(value) || value.tenantId !== tenantId || value.mode !== 'synthetic-only' || value.paymentsEnabled !== false || !Array.isArray(value.orders) || !Array.isArray(value.cases) || !Array.isArray(value.intakeRequests) || !record(value.policy)) throw new RuntimeRepositoryError('unverified_runtime_response', 'The database workspace identity or execution mode did not match.');
      return value;
    },
    readCase,
    async enqueueIntake({ eventId, orderId, complaint } = {}) {
      requireEnabled();
      const input = { p_event_id: eventIdentity(eventId), p_order_id: id(orderId, 'Order identity'), p_complaint: text(complaint, 'Complaint', 8, 4000) };
      const value = await rpc('enqueue_intake', input, true);
      if (!record(value) || !record(value.case) || !record(value.request) || typeof value.request.id !== 'string' || value.request.eventId !== eventId || value.request.caseId !== value.case.id || value.request.orderId !== orderId || typeof value.replayed !== 'boolean' || value.case.orderId !== orderId || value.case.complaint !== input.p_complaint) unexpectedWrite();
      const saved = await readCase(value.case.id).catch(() => unexpectedWrite());
      if (saved.orderId !== orderId || saved.complaint !== input.p_complaint) unexpectedWrite();
      return { ...value, case: saved, readbackVerified: true };
    },
    async claimIntake({ leaseSeconds = 30 } = {}) {
      requireEnabled();
      const value = await rpc('claim_intake', { p_lease_seconds: integer(leaseSeconds, 'Lease duration', 5, 120) }, true);
      if (value === null) return null;
      if (!record(value) || typeof value.requestId !== 'string' || !Number.isSafeInteger(value.fence) || value.fence < 1 || !Number.isFinite(Date.parse(value.leaseUntil)) || !record(value.case) || value.case.id !== value.caseId || !record(value.order) || !Array.isArray(value.evidence) || !record(value.policy)) unexpectedWrite();
      return value;
    },
    async finishIntake({ requestId, fence, proposal } = {}) {
      requireEnabled();
      id(requestId, 'Request identity'); integer(fence, 'Claim version', 1);
      let proposalJson;
      try { proposalJson = JSON.stringify(proposal); } catch { fail('Supply a bounded investigation proposal.'); }
      if (!record(proposal) || !proposalJson || Buffer.byteLength(proposalJson) > 16000 || !hasValidProposalProvenance(proposal)) fail('Supply a bounded investigation proposal.');
      const value = await rpc('finish_intake', { p_request_id: requestId, p_fence: fence, p_proposal: proposal }, true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || !record(value.case) || value.request.caseId !== value.case.id || value.case.approval?.state === 'approved') unexpectedWrite();
      const saved = await readCase(value.case.id).catch(() => unexpectedWrite());
      if (saved.revision < value.case.revision || proposal.source !== 'local' && (!isDeepStrictEqual(value.case.proposal, proposal) || !isDeepStrictEqual(saved.proposal, proposal))) unexpectedWrite();
      return { ...value, case: saved, readbackVerified: true };
    },
    async approveAndReserve({ caseId, expectedRevision, expectedFingerprint, expectedAmountMinor, note, commandId } = {}) {
      requireEnabled();
      id(caseId, 'Case identity'); integer(expectedRevision, 'Case revision'); integer(expectedAmountMinor, 'Refund amount', 1);
      if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) fail('The exact saved approval fingerprint is required.');
      uuid(commandId, 'Approval command identity');
      const input = { p_case_id: caseId, p_expected_revision: expectedRevision, p_expected_fingerprint: expectedFingerprint,
        p_expected_amount_minor: expectedAmountMinor, p_note: text(note, 'Approval reason', 10, 2000), p_command_id: commandId };
      const value = await rpc('approve_and_reserve', input, true);
      if (!record(value) || !record(value.case) || value.case.id !== caseId || !record(value.operation) || typeof value.operation.id !== 'string' || value.operation.status !== 'reserved' || value.operation.submissionEnabled !== false || value.operation.amountMinor !== expectedAmountMinor || typeof value.replayed !== 'boolean') unexpectedWrite();
      const saved = await readCase(caseId).catch(() => unexpectedWrite());
      if (saved.operationId !== value.operation.id || saved.approval?.state !== 'approved' || saved.approval.amountMinor !== expectedAmountMinor || saved.approval.fingerprint !== expectedFingerprint || saved.outcome !== 'approved-not-submitted') unexpectedWrite();
      return { ...value, case: saved, readbackVerified: true };
    },
    async reviewCase({ caseId, expectedRevision, action, note, commandId } = {}) {
      requireEnabled();
      id(caseId, 'Case identity'); integer(expectedRevision, 'Case revision'); uuid(commandId, 'Review command identity');
      if (!['request-evidence', 'close-no-refund', 'reopen'].includes(action)) fail('Choose a supported review action.');
      const cleanNote = text(note, 'Review reason', 10, 2000);
      const value = await rpc('review_case', { p_case_id: caseId, p_expected_revision: expectedRevision,
        p_action: action, p_note: cleanNote, p_command_id: commandId }, true);
      if (!record(value) || value.id !== caseId || !Number.isSafeInteger(value.revision) || value.revision <= expectedRevision ||
        value.review?.action !== action || value.review?.note !== cleanNote || value.approval || value.operationId || value.receipt) unexpectedWrite();
      return checkedWriteRead(value, caseId);
    },
    async recoverIntake({ requestId, expectedRevision, note, commandId } = {}) {
      requireEnabled();
      id(requestId, 'Request identity'); integer(expectedRevision, 'Case revision'); uuid(commandId, 'Recovery command identity');
      const value = await rpc('recover_intake', { p_request_id: requestId, p_expected_revision: expectedRevision,
        p_note: text(note, 'Recovery reason', 10, 2000), p_command_id: commandId }, true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || value.request.status !== 'queued' ||
        !record(value.case) || value.request.caseId !== value.case.id || value.case.intakeRequestId !== requestId || typeof value.replayed !== 'boolean' ||
        !Number.isSafeInteger(value.case.revision) || value.case.revision <= expectedRevision || value.case.status !== 'ready' || value.case.stage !== 'reception' ||
        value.case.approval || value.case.operationId || value.case.receipt) unexpectedWrite();
      const saved = await checkedWriteRead(value.case);
      if (saved.intakeRequestId !== requestId) unexpectedWrite();
      return { ...value, case: saved, readbackVerified: true };
    },
    async failIntake({ requestId, fence, errorCode } = {}) {
      requireEnabled();
      id(requestId, 'Request identity'); integer(fence, 'Claim version', 1);
      if (typeof errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode)) fail('Supply a bounded investigation error code.');
      const value = await rpc('fail_intake', { p_request_id: requestId, p_fence: fence, p_error_code: errorCode }, true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || value.request.fence !== fence ||
        value.request.status !== 'error' || value.request.lastError !== errorCode || !record(value.case) || value.request.caseId !== value.case.id ||
        value.case.intakeRequestId !== requestId || value.case.approval || value.case.operationId || value.case.receipt) unexpectedWrite();
      const saved = await checkedWriteRead(value.case);
      if (saved.intakeRequestId !== requestId) unexpectedWrite();
      return { ...value, case: saved, readbackVerified: true };
    },
  };
}
