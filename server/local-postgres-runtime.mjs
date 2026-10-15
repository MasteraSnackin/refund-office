import { hasValidProposalProvenance } from './investigation-proposal.mjs';
import { isDeepStrictEqual } from 'node:util';
// Local rehearsal transport only. It never constructs a cloud client, reads
// provider credentials or sends HTTP. PostgreSQL still enforces every role.
import { clarificationInput, clarificationContext, verifyClarificationWrite } from './evidence-clarification.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const SQL_STATES = new Set(['22023', '28000', '42501', '40001', '23505', '23503', '23514', '55000', 'P0001']);
const RPC_NAMES = new Set(['read_workspace', 'read_case', 'enqueue_intake', 'claim_intake', 'finish_intake', 'approve_and_reserve', 'review_case', 'recover_intake', 'fail_intake', 'evidence_request', 'submit_clarification']);
export class LocalRuntimeError extends Error {
  constructor(code, message, { uncertain = false } = {}) { super(message); this.name = 'LocalRuntimeError'; this.code = code; this.uncertain = uncertain; }
}
const invalid = message => { throw new LocalRuntimeError('invalid_runtime_input', message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) invalid(`${label} is invalid.`); return value; }
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) invalid(`${label} must be a UUID.`); return value; }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} is outside its allowed range.`); return value; }
function boundedText(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`${label} is invalid.`);
  return value.trim();
}
export function sqlLiteral(value) {
  if (typeof value !== 'string' || value.includes('\u0000')) invalid('SQL text must be a string without a null byte.');
  // The local executor sets standard_conforming_strings before this statement.
  return "'" + value.replaceAll("'", "''") + "'";
}
function typed(value, type) {
  if (type === 'integer' || type === 'bigint') return String(value) + '::' + type;
  return sqlLiteral(type === 'jsonb' ? JSON.stringify(value) : value) + '::' + type;
}
function unexpected(write = true) { throw new LocalRuntimeError('unverified_runtime_response', 'The local database response did not match the requested action. Inspect its saved identity before retrying.', { uncertain: write }); }
function caseValue(value, expectedId) {
  if (!record(value) || !ID.test(value.id || '') || expectedId && value.id !== expectedId || !Number.isSafeInteger(value.revision) || value.revision < 0) unexpected(false);
  return value;
}

export function createLocalPostgresRuntime({ executeSql, tenantId, profile } = {}) {
  if (typeof executeSql !== 'function') invalid('A local SQL executor is required.');
  const tenant = uuid(tenantId, 'Tenant identity');
  const actor = uuid(profile?.userId, 'Local profile identity');
  const actorRole = profile?.role;
  if (!['reviewer', 'investigator'].includes(actorRole)) invalid('Choose a configured local reviewer or investigator profile.');
  function requireRole(role) {
    if (actorRole !== role) throw new LocalRuntimeError('runtime_access_denied', `This local action requires the ${role} profile.`);
  }
  async function rpc(name, args = [], write = false) {
    if (!RPC_NAMES.has(name)) invalid('This local database action is not allowlisted.');
    const parameters = [['p_tenant_id', tenant, 'uuid'], ...args].map(([key, value, type]) => `${key} => ${typed(value, type)}`).join(', ');
    const statement = `SELECT public.refund_runtime_${name}(${parameters});`;
    try { return await executeSql({ statement, role: 'authenticated', userId: actor }); }
    catch (error) {
      if (error instanceof LocalRuntimeError) throw error;
      const state = SQL_STATES.has(error?.sqlState) ? error.sqlState : null;
      if (state) throw new LocalRuntimeError(['42501','28000'].includes(state) ? 'runtime_access_denied' : 'runtime_conflict',
        ['42501','28000'].includes(state) ? 'The local profile cannot perform this database action.' : 'The local database rejected stale, conflicting or invalid input. Refresh the saved record.');
      throw new LocalRuntimeError('runtime_transport_unresolved', 'The local database action could not be confirmed. Retain its original identity and inspect saved state before retrying.', { uncertain: write });
    }
  }
  async function readCase(caseId) { return caseValue(await rpc('read_case', [['p_case_id', id(caseId, 'Case identity'), 'text']]), caseId); }
  async function checkedRead(caseId, minimumRevision) {
    const saved = await readCase(caseId).catch(() => unexpected());
    if (!Number.isSafeInteger(minimumRevision) || saved.revision < minimumRevision) unexpected();
    return saved;
  }
  return {
    async evidenceRequest(caseId) {
      requireRole('reviewer'); id(caseId,'Case identity');
      return clarificationContext(await rpc('evidence_request',[['p_case_id',caseId,'text']]),{tenantId:tenant,caseId});
    },
    async submitClarification({caseId,...input}={}) {
      requireRole('reviewer');id(caseId,'Case identity');const clean=clarificationInput(input);
      const value=await rpc('submit_clarification',[['p_case_id',caseId,'text'],['p_input',clean,'jsonb']],true);
      return verifyClarificationWrite(value,clean,{tenantId:tenant,caseId,actor,readContext:()=>rpc('evidence_request',[['p_case_id',caseId,'text']]),readCase:()=>readCase(caseId)});
    },
    capabilities() { return { storage: 'local-postgres-rehearsal', networkMode: 'offline', cloudConnected: false, liveVerified: false, paymentSubmission: false, identityMode: 'local-test-profile', role: actorRole }; },
    readCase,
    async readWorkspace() {
      const value = await rpc('read_workspace');
      if (!record(value) || value.tenantId !== tenant || value.mode !== 'synthetic-only' || value.paymentsEnabled !== false || !Array.isArray(value.orders) || !Array.isArray(value.cases) || !Array.isArray(value.intakeRequests) || !record(value.policy)) unexpected(false);
      return value;
    },
    async enqueueIntake({ eventId, orderId, complaint } = {}) {
      if (typeof eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(eventId)) invalid('Intake event identity is invalid.');
      const clean = boundedText(complaint, 'Complaint', 8, 4000);
      const value = await rpc('enqueue_intake', [['p_event_id',eventId,'text'],['p_order_id',id(orderId,'Order identity'),'text'],['p_complaint',clean,'text']], true);
      if (!record(value) || !record(value.request) || !record(value.case) || value.request.eventId !== eventId || value.request.caseId !== value.case.id || value.request.orderId !== orderId || typeof value.replayed !== 'boolean' || value.case.orderId !== orderId || value.case.complaint !== clean) unexpected();
      const saved = await checkedRead(value.case.id, value.case.revision);
      if (saved.orderId !== orderId || saved.complaint !== clean || saved.intakeRequestId !== value.request.id) unexpected();
      return { ...value, case: saved, readbackVerified: true };
    },
    async claimIntake({ leaseSeconds = 30 } = {}) {
      requireRole('investigator');
      const value = await rpc('claim_intake', [['p_lease_seconds',integer(leaseSeconds,'Lease duration',5,120),'integer']], true);
      if (value === null) return null;
      if (!record(value) || !ID.test(value.requestId || '') || !Number.isSafeInteger(value.fence) || value.fence < 1 || !Number.isFinite(Date.parse(value.leaseUntil)) || !record(value.case) || value.case.id !== value.caseId || value.case.intakeRequestId !== value.requestId || !record(value.order) || value.order.id !== value.case.orderId || !Array.isArray(value.evidence) || !record(value.policy) || value.case.approval || value.case.operationId || value.case.receipt) unexpected();
      return value;
    },
    async finishIntake({ requestId, fence, proposal } = {}) {
      requireRole('investigator'); id(requestId,'Request identity'); integer(fence,'Claim version',1);
      let encoded; try { encoded = JSON.stringify(proposal); } catch { invalid('Supply a bounded investigation proposal.'); }
      if (!record(proposal) || !encoded || Buffer.byteLength(encoded) > 16000 || !hasValidProposalProvenance(proposal)) invalid('Supply a bounded investigation proposal.');
      const value = await rpc('finish_intake', [['p_request_id',requestId,'text'],['p_fence',fence,'bigint'],['p_proposal',proposal,'jsonb']], true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || !record(value.case) || value.request.caseId !== value.case.id || value.case.approval?.state === 'approved') unexpected();
      const saved = await checkedRead(value.case.id, value.case.revision);
      if (saved.intakeRequestId !== requestId || proposal.source !== 'local' && (!isDeepStrictEqual(value.case.proposal, proposal) || !isDeepStrictEqual(saved.proposal, proposal))) unexpected();
      return { ...value, case: saved, readbackVerified: true };
    },
    async approveAndReserve({ caseId, expectedRevision, expectedFingerprint, expectedAmountMinor, note, commandId } = {}) {
      requireRole('reviewer'); id(caseId,'Case identity'); integer(expectedRevision,'Case revision'); integer(expectedAmountMinor,'Refund amount',1);
      if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) invalid('The exact saved approval fingerprint is required.');
      const value = await rpc('approve_and_reserve', [['p_case_id',caseId,'text'],['p_expected_revision',expectedRevision,'bigint'],['p_expected_fingerprint',expectedFingerprint,'text'],['p_expected_amount_minor',expectedAmountMinor,'bigint'],['p_note',boundedText(note,'Approval reason',10,2000),'text'],['p_command_id',uuid(commandId,'Approval command'),'uuid']], true);
      if (!record(value) || !record(value.case) || value.case.id !== caseId || !record(value.operation) || value.operation.status !== 'reserved' || value.operation.submissionEnabled !== false || value.operation.amountMinor !== expectedAmountMinor || typeof value.replayed !== 'boolean') unexpected();
      const saved = await checkedRead(caseId, value.case.revision);
      if (saved.operationId !== value.operation.id || saved.approval?.state !== 'approved' || saved.approval.fingerprint !== expectedFingerprint || saved.approval.amountMinor !== expectedAmountMinor || saved.outcome !== 'approved-not-submitted') unexpected();
      return { ...value, case: saved, readbackVerified: true };
    },
    async reviewCase({ caseId, expectedRevision, action, note, commandId } = {}) {
      requireRole('reviewer'); id(caseId,'Case identity'); integer(expectedRevision,'Case revision');
      if (!['request-evidence','close-no-refund','reopen'].includes(action)) invalid('Choose a supported review action.');
      const value = await rpc('review_case', [['p_case_id',caseId,'text'],['p_expected_revision',expectedRevision,'bigint'],['p_action',action,'text'],['p_note',boundedText(note,'Review reason',10,2000),'text'],['p_command_id',uuid(commandId,'Review command'),'uuid']], true);
      try { caseValue(value, caseId); } catch { unexpected(); }
      return checkedRead(caseId, value.revision);
    },
    async recoverIntake({ requestId, expectedRevision, note, commandId } = {}) {
      requireRole('investigator'); id(requestId,'Request identity'); integer(expectedRevision,'Case revision');
      const value = await rpc('recover_intake', [['p_request_id',requestId,'text'],['p_expected_revision',expectedRevision,'bigint'],['p_note',boundedText(note,'Recovery reason',10,2000),'text'],['p_command_id',uuid(commandId,'Recovery command'),'uuid']], true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || !record(value.case) || value.request.caseId !== value.case.id || typeof value.replayed !== 'boolean') unexpected();
      return { ...value, case: await checkedRead(value.case.id, value.case.revision), readbackVerified: true };
    },
    async failIntake({ requestId, fence, errorCode } = {}) {
      requireRole('investigator'); id(requestId,'Request identity'); integer(fence,'Claim version',1);
      if (typeof errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode)) invalid('Supply a bounded investigation error code.');
      const value = await rpc('fail_intake', [['p_request_id',requestId,'text'],['p_fence',fence,'bigint'],['p_error_code',errorCode,'text']], true);
      if (!record(value) || !record(value.request) || value.request.id !== requestId || !record(value.case) || value.request.caseId !== value.case.id || value.case.approval?.state === 'approved' || value.case.operationId) unexpected();
      return { ...value, case: await checkedRead(value.case.id, value.case.revision), readbackVerified: true };
    },
  };
}
