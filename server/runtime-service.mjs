import { createProviders } from './providers.mjs';
import { investigationIdentity, prepareInvestigationProposal } from './investigation-proposal.mjs';
import { getIntegrationStatus } from './integration-prep.mjs';
import { clarificationInput } from './evidence-clarification.mjs';
import { buildCaseProvenance } from './case-provenance.mjs';
import { buildRuntimeBriefing, buildRuntimeDecisionReport } from './runtime-outputs.mjs';
import { buildCustomerClarificationDraft } from './customer-drafts.mjs';
import { isDeepStrictEqual } from 'node:util';

export class RuntimeServiceError extends Error {
  constructor(status, code, message, { uncertain = false } = {}) { super(message); this.name = 'RuntimeServiceError'; this.status = status; this.code = code; this.uncertain = uncertain; }
}
const fail = (status, code, message) => { throw new RuntimeServiceError(status, code, message); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
function shape(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'invalid_runtime_input', 'Send only the fields required for this action.');
}
function decisionInput(input, allowed) {
  shape(input, allowed);
  if (!UUID.test(input.commandId || '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.length > 2000) fail(400, 'invalid_runtime_input', 'Use the saved case revision, a stable command identity and a reason of 10–2,000 characters.');
}
function member(session, role) {
  if (!session || !['investigator', 'reviewer'].includes(session.role) || !UUID.test(session.userId || '') || !UUID.test(session.tenantId || '')) fail(401, 'runtime_session_required', 'Choose a local rehearsal profile to continue.');
  if (role && session.role !== role) fail(403, 'runtime_role_required', `This action requires the local ${role} profile.`);
}
const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format((value || 0) / 100);
const capabilities = Object.freeze({ storage: 'postgres-local', runtime: true, networkMode: 'offline', analyser: 'local', payments: 'disabled', paymentSubmission: false, humanApprovalRequired: true, authentication: 'local-rehearsal', liveVerified: false });
const boundedName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const minorAmount = value => Number.isSafeInteger(value) && value >= 0;
const packingLine = line => line && boundedName(line.name) && Number.isSafeInteger(line.ordered) && line.ordered >= 1 && line.ordered <= 100 && Number.isSafeInteger(line.packed) && line.packed >= 0 && line.packed <= line.ordered;

// This is display text derived exclusively from the saved evidence snapshot.
// The original body remains byte-for-byte intact for exports and auditing.
function evidenceDisplay(entry, orderId) {
  if (typeof entry.body !== 'string' || entry.body.length > 262144) return undefined;
  const kind = ['order', 'packing', 'delivery', 'remedies'].find(name => entry.id === `${name}:${orderId}`);
  if (!kind || entry.source !== (kind === 'remedies' ? 'Operational database' : 'Synthetic catalogue')) return undefined;
  let saved;
  try { saved = JSON.parse(entry.body); } catch { return undefined; }
  if (kind === 'order' && saved?.id === orderId && saved.synthetic === true && saved.currency === 'gbp' && minorAmount(saved.totalMinor) && Array.isArray(saved.lines) && saved.lines.length > 0 && saved.lines.length <= 50 && saved.lines.every(line => packingLine(line) && minorAmount(line.unitAmountMinor))) {
    return `Synthetic order ${saved.id}: ${money(saved.totalMinor)} total. Items ordered: ${saved.lines.map(line => `${line.ordered} × ${line.name} at ${money(line.unitAmountMinor)} each`).join('; ')}.`;
  }
  if (kind === 'packing' && Array.isArray(saved) && saved.length > 0 && saved.length <= 50 && saved.every(packingLine)) {
    return saved.map(line => { const missing = line.ordered - line.packed; return `${line.name}: ${line.ordered} ordered, ${line.packed} recorded as packed${missing ? `; ${missing} ${missing === 1 ? 'unit is' : 'units are'} not recorded as packed` : '; all ordered units are recorded as packed'}.`; }).join(' ');
  }
  if (kind === 'delivery' && boundedName(saved?.status) && typeof saved.disputed === 'boolean' && typeof saved.detail === 'string' && saved.detail.length <= 2000) {
    return `Recorded delivery status: ${saved.status}. ${saved.disputed ? 'The delivery is disputed.' : 'The record does not mark a delivery dispute.'} ${saved.detail}`.trim();
  }
  if (kind === 'remedies' && Array.isArray(saved) && saved.length <= 500) {
    if (!saved.length) return 'No earlier remedies or reservations were recorded for this order when the investigation gathered this evidence.';
    if (!saved.every(item => item && boundedName(item.lineId) && minorAmount(item.amountMinor) && (item.seeded === true && item.status === 'succeeded' || item.seeded === false && item.status === 'reserved' && item.submissionEnabled === false))) return undefined;
    return saved.map(item => item.seeded
      ? `Seeded historical remedy: ${money(item.amountMinor)} for item ${item.lineId}. This is supplied synthetic history, not a new payment.`
      : `Existing reservation: ${money(item.amountMinor)} for item ${item.lineId}. It has not been submitted or paid.`).join(' ');
  }
  return undefined;
}

function checkDisplay(check, amountMinor) {
  if (typeof check.pass !== 'boolean') return `${check.label || 'This check'} has no saved result.`;
  const amount = minorAmount(amountMinor) ? money(amountMinor) : 'The proposed amount';
  const detail = {
    'missing-item': ['The saved proposal identifies a missing item with a positive value.', 'The saved proposal did not identify a supported missing item with a positive value.'],
    evidence: ['The saved proposal cites the packing record and only known evidence references.', 'A valid packing reference and matching evidence references were not established.'],
    amount: [`${amount} matches the missing quantity and unit price in the saved check.`, `${amount} did not pass the exact missing-item value check.`],
    delivery: ['The saved delivery record did not mark a dispute.', 'The saved delivery record did not pass the undisputed-delivery check.'],
    limit: [`${amount} passed the policy limit check when this investigation ran.`, `${amount} exceeded the policy limit used by this investigation.`],
    duplicate: ['No existing remedy for the proposed order line and issue was found when this check ran.', 'An existing remedy or reservation was found for the same order line and issue.'],
    balance: [`${amount} was within the remaining order balance when this check ran.`, `${amount} exceeded the remaining order balance when this check ran.`],
  }[check.id];
  return detail ? detail[check.pass ? 0 : 1] : `${check.label || 'This check'} was recorded as ${check.pass ? 'passed' : 'not passed'}.`;
}

// The presenter changes display fields only. The raw database revision and
// fingerprint are retained and must be submitted unchanged for every decision.
export function presentRuntimeCase(raw, { policy, request } = {}) {
  if (!raw || !safeId(raw.id) || !Number.isSafeInteger(raw.revision)) fail(502, 'unverified_runtime_response', 'The saved case could not be verified.');
  const reserved = raw.outcome === 'approved-not-submitted';
  const closed = raw.outcome === 'closed-no-refund';
  const reviewing = raw.status === 'paused' && raw.stage === 'review';
  const failed = request?.status === 'error';
  const status = reserved ? 'reserved' : closed ? 'closed' : reviewing ? 'review' : raw.status;
  let summary = raw.status === 'ready' ? 'Saved in the intake queue. The configured investigator will inspect it.'
    : raw.status === 'running' ? 'The investigator is checking saved evidence and policy. No payment is authorised.'
    : raw.outcome === 'awaiting-approval' ? 'Evidence and policy checks passed. A human reviewer must approve the exact saved amount.'
    : raw.outcome === 'already-resolved' ? 'An explicitly seeded historical remedy covers this item. No new refund was created.'
    : 'The investigation needs a human review. No payment is authorised.';
  if (reserved) summary = `${money(raw.approval?.amountMinor || raw.proposedAmountMinor)} reserved after human approval. Not submitted, not paid; payment execution is disabled.`;
  else if (closed) summary = 'A human reviewer closed this case without a refund. Its evidence and history are preserved.';
  else if (failed) summary = 'The investigation stopped after an error. An investigator must inspect and explicitly recover it.';
  else if (raw.review?.state === 'awaiting-evidence') summary = 'A request for further evidence has been recorded internally. No message was sent. The case is waiting for the requested clarification.';
  const approval = raw.approval || (raw.outcome === 'awaiting-approval' && raw.fingerprint ? {
    state: 'required', amountMinor: raw.proposedAmountMinor, currency: 'gbp', fingerprint: raw.fingerprint,
    fingerprintScheme: raw.fingerprintScheme, orderId: raw.orderId, lineId: raw.proposal?.lineId,
    issue: raw.proposal?.issue, policyVersion: policy?.version, provider: 'disabled',
  } : null);
  return { ...structuredClone(raw), status, runtimeStatus: raw.status, runtime: true, summary, approval,
    paymentSubmissionEnabled: false, seededRemedy: raw.receipt?.seeded === true,
    policySnapshot: policy || null, intakeStatus: request?.status,
    evidence: (raw.evidence || []).map(entry => { const displayBody = evidenceDisplay(entry, raw.orderId); return { ...structuredClone(entry), ...(displayBody ? { displayBody } : {}) }; }),
    checks: (raw.checks || []).map(check => ({ ...check, status: check.pass === true ? 'pass' : check.pass === false ? 'hold' : 'not_checked', detail: checkDisplay(check, raw.proposedAmountMinor) })),
    events: (raw.events || []).map(event => ({ ...event, station: event.type?.startsWith('approval.') ? 'payments' : event.type?.startsWith('review.') ? 'review' : event.type === 'intake.received' ? 'reception' : event.type === 'intake.claimed' ? 'policy' : raw.stage })),
  };
}

export function createRuntimeService({ repositoryForSession, workerRepository, workerDelayMs = 150, automaticWorker = true, evidenceClarification = false, observer, packId, investigationProviders } = {}) {
  if (typeof automaticWorker !== 'boolean' || typeof repositoryForSession !== 'function' || !workerRepository || !Number.isSafeInteger(workerDelayMs) || workerDelayMs < 0 || workerDelayMs > 30000) throw new Error('Configure the local runtime repositories and bounded worker delay.');
  // The literal empty environment is deliberate: shell credentials cannot
  // enable a model or payment adapter in the default application path.
  const investigator = investigationProviders || createProviders({ env: Object.freeze({}) });
  const identity = investigationIdentity(investigator);
  if(typeof evidenceClarification!=='boolean')throw new Error('Choose explicit evidence clarification support.');
  if(packId!==undefined&&!['focused-12','busy-50'].includes(packId))throw new Error('Use an explicitly supported synthetic trace pack.');
  const connectionLimit = identity.mode === 'provider-response' ? 'The selected external analyser is configured. This report does not establish live account acceptance or payment execution.' : identity.mode === 'controlled-test' ? 'Controlled model responses were supplied by a local test transport. No live model or payment provider was contacted by this run.' : 'No external provider is connected.';
  const runtimeCapabilities={...capabilities,evidenceClarification,customerDrafts:true,analyser:identity.provider,analyserMode:identity.mode,analyserModel:identity.model,modelConfigured:identity.provider!=='local',networkMode:identity.mode==='provider-response'?'external-enabled':'offline'};
  let observationFailures = 0;
  const observationFailed = () => { observationFailures += 1; };
  // Tracing is subordinate to the operation. Even a faulty injected recorder
  // cannot repeat a financial command, replace its result or suppress its error.
  function observed(name, attributes, operation, options) {
    if (!observer) return operation();
    let work, called = false;
    const invoke = context => {
      if (!called) { called = true; work = (async () => operation(context))(); }
      else observationFailed();
      return work;
    };
    let observation;
    try { observation = Promise.resolve(observer.span(name, { 'span.kind': 'TOOL', provider: 'local', analyser: identity.provider === 'local' ? 'local-rules' : identity.provider, model: identity.model, analyserMode: identity.mode, synthetic: true, ...(packId?{packId}:{}), ...attributes }, invoke, options)); }
    catch { observationFailed(); }
    if (!called) { observationFailed(); invoke(); }
    if (observation) observation.then(
      value => { void work.then(result => { if (value !== result) observationFailed(); }, () => observationFailed()); },
      error => { void work.then(() => observationFailed(), original => { if (error !== original) observationFailed(); }); },
    );
    return work;
  }
  function caseTraceAttributes(item) {
    const attributes = {};
    if (typeof item?.caseId === 'string' && /^RF-?\d{1,8}$/.test(item.caseId)) attributes.caseId = item.caseId;
    if (Number.isSafeInteger(item?.revision) && item.revision > 0) attributes['case.revision'] = item.revision;
    if (Number.isSafeInteger(item?.proposedAmountMinor) && item.proposedAmountMinor >= 0) attributes.amountMinor = item.proposedAmountMinor;
    if (['awaiting-approval', 'held', 'already-resolved', 'approved-not-submitted', 'closed-no-refund'].includes(item?.outcome)) { attributes['decision.state'] = item.outcome; attributes.outcome = item.outcome; }
    if (Array.isArray(item?.checks)) { attributes['checks.count'] = item.checks.length; attributes['checks.passed'] = item.checks.filter(check => check.pass === true).length; }
    return attributes;
  }
  function observedResult(context, item) {
    const attributes = { synthetic: true, ...caseTraceAttributes(item) };
    try { const result = context?.setAttributes?.(attributes); if (result?.then) void Promise.resolve(result).catch(observationFailed); } catch { observationFailed(); }
  }
  function observabilityStatus() {
    if (!observer) return { enabled: false, mode: 'disabled', networkEnabled: false, serviceFailures: 0 };
    let saved = {};
    try { saved = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(observer.status() || {})).filter(([, descriptor]) => Object.hasOwn(descriptor, 'value')).map(([key, descriptor]) => [key, descriptor.value])); } catch { observationFailed(); }
    // Only recorder metadata may leave this boundary; arbitrary recorder text,
    // file paths and errors must not enter a case bootstrap.
    return { enabled: true, mode: 'local-only', networkEnabled: false,
      serviceFailures: observationFailures, degraded: observationFailures > 0 || saved.recordingErrors > 0 || saved.writeErrors > 0,
      ...Object.fromEntries(['activeSpans', 'completedSpans', 'retainedSpans', 'retainedBytes', 'droppedSpans', 'recordingErrors', 'writeErrors', 'maxSpans', 'maxBytes'].filter(key => Number.isSafeInteger(saved[key]) && saved[key] >= 0).map(key => [key, saved[key]])),
      ...(['memory-only', 'idle', 'pending', 'saved', 'failed'].includes(saved.writeState) ? { writeState: saved.writeState } : {}),
      ...(['memory', 'bounded-jsonl'].includes(saved.storage) ? { storage: saved.storage } : {}) };
  }
  let closed = false, enabled = false, timer = null, inFlight = null;
  const worker = { active: false, lastCaseId: null, lastError: null, completed: 0, failed: 0, lastFailure: null };
  const state = () => ({ ...worker, enabled, active: Boolean(inFlight), mode: identity.provider === 'local' ? 'local-analyser' : identity.mode === 'controlled-test' ? 'controlled-model-test' : 'selected-model', analyser: identity.provider, analyserMode: identity.mode, model: identity.model, paymentsEnabled: false });
  async function repository(session, role) { member(session, role); return await repositoryForSession(session); }
  function context(workspace, id) { return { policy: workspace.policy, request: workspace.intakeRequests.find(item => item.caseId === id) }; }
  const present = (item, workspace) => presentRuntimeCase(item, context(workspace, item.id));
  function schedule(delay = workerDelayMs) {
    if (!automaticWorker || closed || !enabled || timer) return;
    timer = setTimeout(async () => { timer = null; if (closed || !enabled) return;
      if (inFlight) { schedule(Math.max(workerDelayMs, 50)); return; }
      try { const result = await investigate(workerRepository, { background: true }); schedule(result.empty ? Math.max(workerDelayMs, 1000) : workerDelayMs); }
      catch { enabled = false; }
    }, delay);
    timer.unref?.();
  }
  async function confirmStoppedClaim(repo, claim, before, code) {
    // failIntake's returned receipt is not independent evidence. Read the
    // workspace again and bind the stopped request to this exact claim. A
    // changed fence, concurrent edit or unreadable result stops the queue.
    const saved = await repo.readWorkspace();
    if (!saved || !UUID.test(saved.tenantId || '') || saved.mode !== 'synthetic-only' || saved.paymentsEnabled !== false || !Array.isArray(saved.cases) || !Array.isArray(saved.intakeRequests)) return null;
    const requests = saved.intakeRequests.filter(item => item.id === claim.requestId), cases = saved.cases.filter(item => item.id === claim.caseId);
    if (requests.length !== 1 || cases.length !== 1) return null;
    const request = requests[0], item = cases[0], event = item.events?.at(-1);
    if (request.caseId !== claim.caseId || request.orderId !== before.orderId || request.fence !== claim.fence || request.status !== 'error' || request.lastError !== code || request.leaseUntil != null ||
      item.intakeRequestId !== claim.requestId || item.revision !== before.revision + 1 || item.status !== 'paused' || item.stage !== 'review' || item.outcome !== 'held' || item.fingerprint != null || item.approval || item.operationId || item.receipt ||
      event?.type !== 'intake.failed' || event.payload?.errorCode !== code || event.payload?.fence !== claim.fence || !UUID.test(event.actor || '') ||
      ['complaint', 'orderId', 'title', 'shortTitle', 'proposedAmountMinor', 'proposal', 'checks', 'evidence'].some(key => !isDeepStrictEqual(item[key], before[key]))) return null;
    return { case: item, request };
  }
  async function investigate(repo, { background = false } = {}) {
    if (closed) fail(503, 'runtime_closed', 'The local rehearsal is stopping.');
    if (inFlight) fail(409, 'runtime_worker_busy', 'An investigation is already in progress.');
    let safelyHeld = false;
    inFlight = observed('refund.investigation', { component: 'investigation', action: 'investigate', 'span.kind': 'CHAIN' }, async trace => {
      let claim, before, phase = 'claim';
      try {
        claim = await observed('refund.investigation.claim', { component: 'investigation', action: 'claim' }, async trace => {
          const saved = await repo.claimIntake({ leaseSeconds: 30 }); if (saved) observedResult(trace, saved.case); return saved;
        }, { omitNull: true });
        if (!claim) return null;
        if (claim.case?.approval || claim.case?.receipt || claim.case?.operationId || claim.case?.stage !== 'policy' || claim.case?.status !== 'running') fail(409, 'invalid_investigation_claim', 'The claim is outside the preapproval investigation boundary.');
        before = structuredClone(claim.case);
        worker.lastCaseId = claim.caseId;
        observedResult(trace, claim.case);
        const input = { complaint: claim.case.complaint, order: claim.order, evidence: claim.evidence };
        phase = 'propose';
        const proposal = await observed('refund.investigation.propose', { component: 'investigation', action: 'propose', provider: identity.provider, 'span.kind': identity.provider === 'local' ? 'TOOL' : 'LLM', ...caseTraceAttributes(claim.case), 'records.count': claim.evidence.length }, async () => {
          const proposed = await investigator.proposeCase(structuredClone(input));
          return prepareInvestigationProposal(proposed, input, identity);
        });
        phase = 'finish';
        const result = await observed('refund.investigation.finish', { component: 'investigation', action: 'finish', ...caseTraceAttributes(claim.case) }, async completion => {
          const saved = await repo.finishIntake({ requestId: claim.requestId, fence: claim.fence, proposal });
          observedResult(completion, saved.case); return saved;
        });
        observedResult(trace, result.case);
        worker.completed += 1; worker.lastError = null;
        return { ...result, case: presentRuntimeCase(result.case, { policy: claim.policy, request: result.request }) };
      } catch (error) {
        const code = /^[a-z][a-z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'investigation_failed';
        worker.failed += 1;
        worker.lastError = { code, message: 'Investigation stopped. Inspect the saved case before recovering it.' };
        worker.lastFailure = { caseId: safeId(claim?.caseId) ? claim.caseId : null, code, safelyHeld: false };
        if (claim && typeof repo.failIntake === 'function') {
          try {
            await observed('refund.investigation.hold', { component: 'investigation', action: 'hold', ...caseTraceAttributes(before) }, async hold => {
              const saved = await repo.failIntake({ requestId: claim.requestId, fence: claim.fence, errorCode: code }); observedResult(hold, saved?.case); return saved;
            });
            // Only explicit proposal validation/refusal is case-local. Database
            // errors, transport uncertainty, access failures and unknown code
            // paths must never be converted into permission to claim more work.
            const caseLocal = phase === 'propose' && error?.uncertain !== true && ![401, 403].includes(error?.status) &&
              ['invalid_proposal', 'invalid_investigation_proposal', 'analysis_refused'].includes(code) &&
              safeId(claim.requestId) && safeId(claim.caseId) && claim.caseId === before?.id && Number.isSafeInteger(claim.fence) && claim.fence > 0 && Number.isSafeInteger(before.revision) &&
              before.intakeRequestId === claim.requestId && Number.isFinite(Date.parse(claim.leaseUntil)) && typeof repo.readWorkspace === 'function';
            if (caseLocal) {
              const stopped = await observed('refund.investigation.verify-hold', { component: 'investigation', action: 'verify-hold', ...caseTraceAttributes(before) }, async confirmation => {
                const value = await confirmStoppedClaim(repo, claim, before, code);
                if (!value) fail(503, 'investigation_hold_unverified', 'The stopped investigation could not be independently verified.');
                observedResult(confirmation, value.case); return value;
              });
              safelyHeld = true; observedResult(trace, stopped.case);
              worker.lastFailure.safelyHeld = true;
              worker.lastError = { code, message: 'This case is held for explicit investigator recovery. Other queued cases may continue.' };
            }
          }
          catch { /* A committed finish or newer fence must never be overwritten. */ }
        }
        throw error;
      }
    }, { omitNull: true });
    try { return (await inFlight) || { empty: true }; }
    catch (error) {
      if (!safelyHeld) { enabled = false; clearTimeout(timer); timer = null; }
      if (background && safelyHeld) return { failed: true, safelyHeld: true };
      throw error;
    }
    finally { inFlight = null; }
  }
  async function workspaceFor(session) { const repo = await repository(session); return { repo, workspace: await repo.readWorkspace() }; }
  async function packet(session, id) {
    if (!safeId(id)) fail(400, 'invalid_case_id', 'The case identifier is invalid.');
    const { workspace } = await workspaceFor(session);
    const raw = workspace.cases.find(item => item.id === id);
    if (!raw) fail(404, 'case_not_found', 'That case is not available in this workspace.');
    return { schemaVersion: 1, mode: 'local-postgres-rehearsal', synthetic: true, paymentSubmissionEnabled: false,
      tenantId: workspace.tenantId, case: present(raw, workspace), order: workspace.orders.find(item => item.id === raw.orderId),
      policy: workspace.policy, capabilities: { ...runtimeCapabilities }, exportedAt: new Date().toISOString(),
      limitations: ['Synthetic records only.', 'Local rehearsal identities are not online accounts.', 'Reservations are not submitted or paid.', connectionLimit] };
  }
  return {
    async evidenceRequest(session,id){
      member(session,'reviewer');if(!evidenceClarification)fail(503,'evidence_clarification_disabled','Customer clarification is unavailable in this workspace.');
      if(!safeId(id))fail(400,'invalid_case_id','The case identifier is invalid.');
      return (await repository(session,'reviewer')).evidenceRequest(id);
    },
    async submitClarification(session,id,input){
      member(session,'reviewer');if(!evidenceClarification)fail(503,'evidence_clarification_disabled','Customer clarification is unavailable in this workspace.');
      if(!safeId(id))fail(400,'invalid_case_id','The case identifier is invalid.');
      const clean=clarificationInput(input),{repo,workspace}=await workspaceFor(session);
      const result=await observed('refund.evidence.clarify',{component:'evidence',action:'clarify','case.revision':clean.expectedRevision},async trace=>{
        const saved=await repo.submitClarification({caseId:id,...clean});observedResult(trace,saved.case);return saved;
      });
      if(result.submission.actor!==session.userId)throw new RuntimeServiceError(503,'unverified_runtime_response','The recorded reviewer identity could not be verified. Retain the original command.',{uncertain:true});
      worker.lastError=null;enabled=automaticWorker;schedule(0);
      return {...result,case:presentRuntimeCase(result.case,{policy:workspace.policy,request:result.request})};
    },
    async bootstrap(session) {
      const { workspace } = await workspaceFor(session);
      return { cases: workspace.cases.map(item => present(item, workspace)), orders: workspace.orders, policy: { ...workspace.policy, humanApprovalRequired: true },
        capabilities: { ...runtimeCapabilities }, intakeRequests: workspace.intakeRequests,
        runtime: { mode: 'local-postgres-rehearsal', paymentsEnabled: false, worker: state(), observability: observabilityStatus() },
        session: { userId: session.userId, profileId: session.profileId, role: session.role, expiresAt: session.expiresAt },
        demoDataset: { id: 'postgres-rehearsal', title: 'Local PostgreSQL rehearsal', synthetic: true, caseCount: workspace.cases.length } };
    },
    async getCase(session, id) { return (await packet(session, id)).case; },
    async listIntake(session) { const { workspace } = await workspaceFor(session); return { mode: 'local-postgres-rehearsal', requests: workspace.intakeRequests, worker: state() }; },
    async intake(session, input) {
      shape(input, ['eventId', 'orderId', 'complaint']); const { repo, workspace } = await workspaceFor(session);
      const result = await observed('refund.intake', { component: 'intake', action: 'enqueue' }, async trace => {
        const saved = await repo.enqueueIntake(input); observedResult(trace, saved.case); return saved;
      }); schedule(0);
      return { ...result, case: presentRuntimeCase(result.case, { policy: workspace.policy, request: result.request }) };
    },
    async approve(session, id, input) {
      member(session, 'reviewer'); if (!safeId(id)) fail(400, 'invalid_case_id', 'The case identifier is invalid.');
      decisionInput(input, ['expectedRevision', 'expectedAmountMinor', 'fingerprint', 'expectedFingerprint', 'note', 'commandId']);
      if (input.fingerprint && input.expectedFingerprint && input.fingerprint !== input.expectedFingerprint) fail(400, 'invalid_runtime_input', 'Approval fingerprints disagree.');
      const { repo, workspace } = await workspaceFor(session);
      const result = await observed('refund.review.approve', { component: 'review', action: 'approve', 'case.revision': input.expectedRevision }, async trace => {
        const saved = await repo.approveAndReserve({ caseId: id, ...input, expectedFingerprint: input.expectedFingerprint || input.fingerprint }); observedResult(trace, saved.case); return saved;
      });
      return presentRuntimeCase(result.case, { policy: workspace.policy, request: result.request });
    },
    async review(session, id, input) {
      member(session, 'reviewer'); if (!safeId(id)) fail(400, 'invalid_case_id', 'The case identifier is invalid.');
      decisionInput(input, ['action', 'expectedRevision', 'note', 'commandId']);
      if (!['request-evidence', 'close-no-refund', 'reopen'].includes(input.action)) fail(400, 'invalid_runtime_input', 'Choose a supported review decision.');
      const { repo, workspace } = await workspaceFor(session);
      const result = await observed('refund.review.decide', { component: 'review', action: 'review', 'case.revision': input.expectedRevision }, async trace => {
        const saved = await repo.reviewCase({ caseId: id, ...input }); observedResult(trace, saved); return saved;
      });
      return presentRuntimeCase(result, { policy: workspace.policy });
    },
    async resume(session, requestId, input) {
      member(session, 'investigator'); if (!safeId(requestId)) fail(400, 'invalid_intake_id', 'The intake identifier is invalid.');
      decisionInput(input, ['expectedRevision', 'note', 'commandId']);
      const { repo, workspace } = await workspaceFor(session);
      const result = await observed('refund.investigation.recover', { component: 'investigation', action: 'recover', 'case.revision': input.expectedRevision }, async trace => {
        const saved = await repo.recoverIntake({ requestId, ...input }); observedResult(trace, saved.case); return saved;
      });
      worker.lastError = null; enabled = automaticWorker; schedule(0);
      return { ...result, case: presentRuntimeCase(result.case, { policy: workspace.policy, request: result.request }) };
    },
    async runNext(session) { const repo = await repository(session, 'investigator'); const result = await investigate(repo); if (enabled) schedule(); return result; },
    exportCase: packet,
    async customerDraft(session, id) { return buildCustomerClarificationDraft(await packet(session, id)); },
    async history(session, id) { const result = await packet(session, id); return { caseId: result.case.caseId, revision: result.case.revision, events: result.case.events }; },
    async briefing(session, id) {
      const { case: item } = await packet(session, id);
      return buildRuntimeBriefing(item, { paymentText: 'Payment submission is disabled. No money has moved in this rehearsal.' });
    },
    async boardExport(session, id) {
      return buildCaseProvenance(await packet(session,id));
    },
    async report(session, id) {
      const saved = await packet(session, id), item = saved.case;
      return buildRuntimeDecisionReport(item, { connectionText: identity.provider === 'local' ? 'No online account, model provider, payment provider or Supabase endpoint was connected.' : connectionLimit });
    },
    integrations() { return getIntegrationStatus({ capabilities: { ...runtimeCapabilities } }); },
    workerState: state,
    observabilityStatus,
    start() { if (closed) throw new Error('The runtime service is closed.'); enabled = automaticWorker; schedule(0); },
    async close() {
      closed = true; enabled = false; clearTimeout(timer); timer = null;
      if (inFlight) await inFlight.catch(() => {});
      let timeout;
      try { if (observer?.flush) await Promise.race([observer.flush(), new Promise(resolve => { timeout = setTimeout(() => { observationFailed(); resolve(); }, 1000); })]); }
      catch { observationFailed(); } finally { clearTimeout(timeout); }
    },
  };
}
