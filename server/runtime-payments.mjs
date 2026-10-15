// Prepared Stripe TEST execution for separately gated hosted routes only.
// The database authorisation, dedicated executor role and irreversible saved
// submission intent are independent of the earlier disabled reservation.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonical(a) === canonical(b);
function canonical(value) { return JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item); }
function amount(value) { return Number.isSafeInteger(value) && value > 0; }
function stripeId(value, prefix) { return typeof value === 'string' && new RegExp('^' + prefix + '_[A-Za-z0-9]{1,100}$').test(value); }

export class RuntimePaymentError extends Error {
  constructor(code, message, { uncertain = false } = {}) { super(message); this.name = 'RuntimePaymentError'; this.code = code; this.uncertain = uncertain; }
}
function fail(code, message, uncertain = false) { throw new RuntimePaymentError(code, message, { uncertain }); }
export function requireRuntimePaymentGate(env = {}) {
  if (env.REFUND_OFFICE_NETWORK !== 'enabled' || env.REFUND_OFFICE_PAYMENT_EXECUTION !== 'stripe-test' || !String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(v => v.trim()).includes('stripe-runtime')) {
    fail('payment_execution_disabled', 'Stripe test execution is disconnected. No repository or payment provider was called.');
  }
}
function validExecution(value) {
  if (!record(value) || !UUID.test(value.id || '') || !UUID.test(value.tenantId || '') || !ID.test(value.operationId || '') || !ID.test(value.caseId || '') || !record(value.mapping) || !record(value.payload) || !record(value.authorisation) || !record(value.originalApproval) || !record(value.originalOperation)) fail('unverified_execution', 'The saved execution authorisation is incomplete.');
  const e = structuredClone(value), p = e.payload, m = e.mapping, op = e.originalOperation, a = e.originalApproval;
  const metadata = { runtime_execution_id: e.id, refund_office_operation_id: e.operationId, refund_office_order_id: op.orderId, refund_office_tenant_id: e.tenantId };
  if (!stripeId(m.accountId, 'acct') || !stripeId(m.paymentIntentId, 'pi') || !amount(m.paymentAmountMinor) || m.currency !== 'gbp' || m.livemode !== false || !ID.test(m.orderId || '') || op.orderId !== m.orderId || !ID.test(op.lineId || '') || op.id !== e.operationId || op.status !== 'reserved' || op.seeded !== false || op.provider !== 'local-disabled' || op.submissionEnabled !== false || op.receipt !== null || op.issue !== 'item_missing' || !amount(op.amountMinor) || op.amountMinor > m.paymentAmountMinor || a.id !== op.approvalId || a.operation_id !== op.id || a.case_id !== e.caseId || a.tenant_id !== e.tenantId || a.amount_minor !== op.amountMinor || !HEX.test(a.fingerprint || '') || a.fingerprint !== e.authorisation.originalFingerprint || a.snapshot?.order?.totalMinor !== m.paymentAmountMinor || !Number.isSafeInteger(e.authorisation.caseRevision) || e.authorisation.caseRevision < 1 || !UUID.test(e.authorisation.actor || '') || !HEX.test(e.payloadDigest || '') || e.idempotencyKey !== `refund-office-stripe-test-${e.id}` || !same(p, { executionId: e.id, operationId: op.id, orderId: op.orderId, lineId: op.lineId, issue: op.issue, amountMinor: op.amountMinor, currency: 'gbp', accountId: m.accountId, paymentIntentId: m.paymentIntentId, paymentAmountMinor: m.paymentAmountMinor, idempotencyKey: e.idempotencyKey, metadata })) {
    fail('unverified_execution', 'The saved execution does not match the exact original approval, amount and Stripe test mapping.');
  }
  if (!Number.isSafeInteger(e.fence) || e.fence < 0) fail('unverified_execution', 'The saved execution fence is invalid.');
  const unsubmitted = ['authorised', 'claimed'].includes(e.status);
  if (!['authorised','claimed','submitting','uncertain','response-saved','reconciling','pending','succeeded','failed'].includes(e.status) || unsubmitted && (e.submittedAt !== null || e.refundId !== null || e.receipt !== null) || !unsubmitted && !Number.isFinite(Date.parse(e.submittedAt)) || e.refundId !== null && !stripeId(e.refundId, 're')) fail('unverified_execution', 'The saved execution status is inconsistent with its submission record.');
  if (e.receipt !== null) {
    normaliseRuntimeRefund(e.receipt, e);
    if (!e.refundId || ['succeeded','failed','pending'].includes(e.status) && e.status !== (e.receipt.status === 'succeeded' ? 'succeeded' : ['failed','canceled'].includes(e.receipt.status) ? 'failed' : 'pending')) fail('unverified_execution', 'The saved receipt does not confirm the displayed execution result.');
  } else if (['succeeded','failed','pending'].includes(e.status)) fail('unverified_execution', 'The execution result has no independently saved refund receipt.');
  return e;
}
function validContext(value, tenantId, caseId) {
  if (!record(value) || value.tenantId !== tenantId || value.caseId !== caseId || !Number.isSafeInteger(value.caseRevision) || value.caseRevision < 1 || typeof value.eligible !== 'boolean' || value.eligible && value.blockedReason !== null || !value.eligible && (typeof value.blockedReason !== 'string' || !value.blockedReason || value.blockedReason.length > 300) || !Object.hasOwn(value, 'execution') || !Object.hasOwn(value, 'binding')) fail('unverified_payment_context', 'The saved payment review context could not be verified.');
  const result = structuredClone(value), b = result.binding;
  if (b !== null && (!record(b) || !ID.test(b.operationId || '') || !Number.isSafeInteger(b.expectedCaseRevision) || b.expectedCaseRevision < 1 || !UUID.test(b.originalApprovalId || '') || !HEX.test(b.originalFingerprint || '') || !amount(b.expectedAmountMinor) || !ID.test(b.orderId || '') || !ID.test(b.lineId || '') || !amount(b.paymentAmountMinor) || b.expectedAmountMinor > b.paymentAmountMinor || b.currency !== 'gbp' || !UUID.test(b.originalApprovedBy || '') || !Number.isFinite(Date.parse(b.originalApprovedAt)))) fail('unverified_payment_context', 'The original approval binding is incomplete.');
  if (result.execution !== null) {
    const e = validExecution(result.execution);
    if (result.eligible || !b || e.tenantId !== tenantId || e.caseId !== caseId || e.operationId !== b.operationId || e.originalApproval.id !== b.originalApprovalId || e.authorisation.originalFingerprint !== b.originalFingerprint || e.authorisation.caseRevision !== b.expectedCaseRevision || e.payload.amountMinor !== b.expectedAmountMinor || e.payload.orderId !== b.orderId || e.payload.lineId !== b.lineId || e.mapping.paymentAmountMinor !== b.paymentAmountMinor) fail('unverified_payment_context', 'The saved execution does not belong to this original approval.');
    result.execution = e;
  } else if (result.eligible && (!b || b.expectedCaseRevision !== result.caseRevision)) fail('unverified_payment_context', 'The case has no current approval eligible for execution.');
  return result;
}
function sameIntent(expected, saved, { lease = false } = {}) {
  const e = validExecution(saved);
  for (const key of ['id','tenantId','operationId','caseId','originalApproval','originalOperation','authorisation','mapping','payload','payloadDigest','idempotencyKey']) {
    if (!same(expected[key], e[key])) fail('unverified_execution', 'The independently read execution differs from the saved authorisation.', true);
  }
  if (lease && (expected.fence !== e.fence || expected.leaseActor !== e.leaseActor)) fail('stale_execution_lease', 'The execution claim changed; no further provider action is permitted.', true);
  return e;
}
function activeLease(e, now, statuses) {
  if (!statuses.includes(e.status) || !UUID.test(e.leaseActor || '') || !Number.isFinite(Date.parse(e.leaseUntil)) || Date.parse(e.leaseUntil) <= now()) fail('stale_execution_lease', 'The saved execution lease is unavailable or expired.');
}
export function normaliseRuntimeRefund(value, execution) {
  const p = execution.payload;
  if (!record(value) || !stripeId(value.id, 're') || value.amount !== p.amountMinor || value.currency !== 'gbp' || value.payment_intent !== p.paymentIntentId || !['succeeded','pending','failed','requires_action','canceled'].includes(value.status) || !same(value.metadata, p.metadata) || execution.refundId && execution.refundId !== value.id || value.livemode === true) fail('refund_mismatch', 'The provider observation does not match the authorised test refund.', true);
  return structuredClone({ id: value.id, amount: value.amount, currency: value.currency, payment_intent: value.payment_intent, status: value.status, metadata: value.metadata });
}
async function verifyFunding(provider, e, { beforeSubmission }) {
  const account = await provider.readAccount();
  if (!record(account) || account.id !== e.mapping.accountId) fail('stripe_account_mismatch', 'The Stripe test account does not match the new execution authorisation.');
  const pi = await provider.readPaymentIntent(e.mapping.paymentIntentId), p = e.payload;
  if (!record(pi) || pi.id !== p.paymentIntentId || pi.livemode !== false || pi.status !== 'succeeded' || pi.currency !== 'gbp' || pi.amount !== p.paymentAmountMinor || pi.amount_received !== p.paymentAmountMinor || pi.metadata?.refund_office_order_id !== p.orderId || pi.metadata?.refund_office_tenant_id !== e.tenantId || !stripeId(pi.latest_charge, 'ch')) fail('stripe_payment_mismatch', 'The existing Stripe test payment does not match the authorised order, tenant and exact amount.');
  const charge = await provider.readCharge(pi.latest_charge);
  if (!record(charge) || charge.id !== pi.latest_charge || charge.payment_intent !== pi.id || charge.livemode !== false || charge.currency !== 'gbp' || charge.paid !== true || charge.captured !== true || charge.amount !== p.paymentAmountMinor || charge.amount_captured !== p.paymentAmountMinor || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount_captured || beforeSubmission && charge.amount_captured - charge.amount_refunded < p.amountMinor) fail('stripe_charge_mismatch', 'The retrieved Stripe test charge does not support this exact refund.');
}

export function createRuntimePaymentExecutor({ env = {}, repository, provider, now = Date.now } = {}) {
  async function unknown(e) {
    try { await repository.noteExecutionUnknown({ executionId: e.id, fence: e.fence, errorCode: 'provider_result_unresolved' }); } catch { /* Saved intent remains the recovery boundary even if this acknowledgement is unavailable. */ }
  }
  async function readback(e) {
    const observed = normaliseRuntimeRefund(await provider.readRefund(e.refundId), e);
    const result = sameIntent(e, await repository.recordRefundReadback({ executionId: e.id, fence: e.fence, refund: observed }), { lease: true });
    const saved = sameIntent(e, await repository.readExecution(e.id), { lease: true });
    const status = observed.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(observed.status) ? 'failed' : 'pending';
    if (!same(saved.receipt, observed) || saved.status !== status || !same(result.receipt, observed) || result.status !== status) fail('readback_unconfirmed', 'The independent refund retrieval was not confirmed in the saved execution.', true);
    return { execution: saved, readbackVerified: true, providerMode: 'stripe-test', liveVerified: false };
  }
  return {
    async execute(executionId) {
      requireRuntimePaymentGate(env);
      if (!UUID.test(executionId || '')) fail('invalid_execution_id', 'A saved execution identity is required.');
      const e = validExecution(await repository.claimExecution({ executionId, leaseSeconds: 30 }));
      if (e.id !== executionId || e.submittedAt !== null || e.refundId !== null) fail('unverified_execution', 'Only an unsubmitted claimed authorisation can be executed.');
      activeLease(e, now, ['claimed']);
      await verifyFunding(provider, e, { beforeSubmission: true });
      let intentAttempted = false;
      try {
        // Even a lost beginSubmission acknowledgement may have persisted. From
        // this point every failure is uncertain and no POST retry is automatic.
        intentAttempted = true;
        const intent = sameIntent(e, await repository.beginSubmission({ executionId, fence: e.fence, payloadDigest: e.payloadDigest }), { lease: true });
        const saved = sameIntent(intent, await repository.readExecution(executionId), { lease: true });
        activeLease(saved, now, ['submitting']);
        if (!saved.submittedAt || saved.refundId !== null || saved.receipt !== null || intent.status !== 'submitting' || intent.submittedAt !== saved.submittedAt) fail('intent_unconfirmed', 'The durable submission intent could not be independently verified.', true);
        const response = normaliseRuntimeRefund(await provider.createRefund(structuredClone(saved.payload)), saved);
        const reference = sameIntent(saved, await repository.saveRefundReference({ executionId, fence: e.fence, refund: response }), { lease: true });
        if (reference.refundId !== response.id || reference.status !== 'response-saved') fail('reference_unconfirmed', 'The returned refund identity could not be saved.', true);
        const persisted = sameIntent(reference, await repository.readExecution(executionId), { lease: true });
        if (persisted.refundId !== response.id || persisted.status !== 'response-saved') fail('reference_unconfirmed', 'The returned refund identity could not be independently verified.', true);
        return await readback(persisted);
      } catch {
        if (intentAttempted) await unknown(e);
        fail('payment_execution_uncertain', 'The saved execution needs inspection. No second submission is permitted; only a saved refund identity can be retrieved.', true);
      }
    },
    async reconcile(executionId) {
      requireRuntimePaymentGate(env);
      if (!UUID.test(executionId || '')) fail('invalid_execution_id', 'A saved execution identity is required.');
      const e = validExecution(await repository.claimReconciliation({ executionId, leaseSeconds: 30 }));
      if (e.id !== executionId || !e.submittedAt || !stripeId(e.refundId, 're')) fail('unverified_execution', 'Reconciliation requires a saved submitted refund identity.');
      activeLease(e, now, ['reconciling']);
      try { await verifyFunding(provider, e, { beforeSubmission: false }); return await readback(e); }
      catch { await unknown(e); fail('payment_reconciliation_uncertain', 'The saved refund could not be independently confirmed. No refund was submitted by this reconciliation.', true); }
    },
  };
}

// The transport is injected, so local SQL tests and a future authenticated RPC
// transport share the same exact domain calls. There is no arbitrary RPC name,
// caller-supplied actor, service-role key, provider or automatic HTTP fallback.
export function createRuntimePaymentRepository({ env = {}, tenantId, rpc } = {}) {
  if (!UUID.test(tenantId || '') || typeof rpc !== 'function') fail('invalid_payment_repository', 'A tenant and authenticated RPC transport are required.');
  async function call(name, args) {
    requireRuntimePaymentGate(env);
    const acknowledgement = await rpc('refund_runtime_' + name, { p_tenant_id: tenantId, ...args });
    let result;
    try { result = validExecution(acknowledgement); }
    catch (error) {
      if (error instanceof RuntimePaymentError && name !== 'read_execution') error.uncertain = true;
      throw error;
    }
    if (result.tenantId !== tenantId) fail('unverified_execution', 'The execution belongs to another workspace.', true);
    if (args.p_execution_id && result.id !== args.p_execution_id) fail('unverified_execution', 'The response belongs to a different saved execution.', true);
    if (name === 'authorise_execution' && (result.operationId !== args.p_operation_id || result.originalApproval.id !== args.p_original_approval_id || result.payload.amountMinor !== args.p_expected_amount_minor || result.authorisation.caseRevision !== args.p_expected_case_revision || result.authorisation.originalFingerprint !== args.p_original_fingerprint || result.authorisation.note !== args.p_note || !same(result.mapping, args.p_mapping))) fail('unverified_execution', 'The recorded execution authorisation differs from the exact reviewer decision.', true);
    return result;
  }
  return {
    async paymentAuthorisationContext(caseId) {
      requireRuntimePaymentGate(env);
      if (typeof caseId !== 'string' || !ID.test(caseId)) fail('invalid_payment_case', 'Use the saved case identity.');
      return validContext(await rpc('refund_runtime_payment_authorisation_context', { p_tenant_id: tenantId, p_case_id: caseId }), tenantId, caseId);
    },
    authoriseExecution: input => call('authorise_execution', { p_operation_id: input.operationId, p_expected_case_revision: input.expectedCaseRevision, p_original_approval_id: input.originalApprovalId, p_original_fingerprint: input.originalFingerprint, p_expected_amount_minor: input.expectedAmountMinor, p_mapping: input.mapping, p_note: input.note, p_command_id: input.commandId }),
    readExecution: executionId => call('read_execution', { p_execution_id: executionId }),
    claimExecution: ({ executionId, leaseSeconds = 30 }) => call('claim_execution', { p_execution_id: executionId, p_lease_seconds: leaseSeconds }),
    beginSubmission: ({ executionId, fence, payloadDigest }) => call('begin_submission', { p_execution_id: executionId, p_fence: fence, p_payload_digest: payloadDigest }),
    saveRefundReference: ({ executionId, fence, refund }) => call('save_refund_reference', { p_execution_id: executionId, p_fence: fence, p_refund: refund }),
    noteExecutionUnknown: ({ executionId, fence, errorCode }) => call('note_execution_unknown', { p_execution_id: executionId, p_fence: fence, p_error_code: errorCode }),
    claimReconciliation: ({ executionId, leaseSeconds = 30 }) => call('claim_reconciliation', { p_execution_id: executionId, p_lease_seconds: leaseSeconds }),
    recordRefundReadback: ({ executionId, fence, refund }) => call('record_refund_readback', { p_execution_id: executionId, p_fence: fence, p_refund: refund }),
  };
}

export function createRuntimeStripeTestProvider({ env = {}, fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { payload } = {}) {
    requireRuntimePaymentGate(env);
    // Key access occurs strictly after the complete execution gate.
    const key = env.STRIPE_SECRET_KEY;
    if (typeof key !== 'string' || !/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) fail('stripe_test_key_required', 'A dedicated Stripe test key is required; live keys are rejected.');
    const headers = { Authorization: 'Bearer ' + key };
    let body;
    if (payload) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Idempotency-Key'] = payload.idempotencyKey;
      body = new URLSearchParams({ payment_intent: payload.paymentIntentId, amount: String(payload.amountMinor), ...Object.fromEntries(Object.entries(payload.metadata).map(([k, v]) => [`metadata[${k}]`, v])) });
    }
    let response;
    try { response = await fetchImpl('https://api.stripe.com' + path, { method: payload ? 'POST' : 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { fail('stripe_transport_unresolved', 'The Stripe test response could not be confirmed.', Boolean(payload)); }
    if (!response?.ok || !response.body?.getReader) fail('stripe_response_unavailable', 'The Stripe test response was unavailable.', Boolean(payload));
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) { await reader.cancel(); fail('stripe_response_unavailable', 'The Stripe test response exceeded its limit.', Boolean(payload)); } chunks.push(Buffer.from(part.value)); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!record(data)) throw new Error('shape'); return data;
    } catch (error) { if (error instanceof RuntimePaymentError) throw error; fail('stripe_response_unavailable', 'The Stripe test response could not be read.', Boolean(payload)); }
  }
  const get = (value, prefix, path) => { if (!stripeId(value, prefix)) fail('invalid_stripe_identity', 'The saved Stripe identity is invalid.'); return request(path + value); };
  return {
    readAccount: () => request('/v1/account'),
    readPaymentIntent: id => get(id, 'pi', '/v1/payment_intents/'),
    readCharge: id => get(id, 'ch', '/v1/charges/'),
    readRefund: id => get(id, 're', '/v1/refunds/'),
    createRefund(payload) {
      requireRuntimePaymentGate(env);
      if (!record(payload) || !UUID.test(payload.executionId || '') || !amount(payload.amountMinor) || !stripeId(payload.paymentIntentId, 'pi') || payload.idempotencyKey !== `refund-office-stripe-test-${payload.executionId}` || !record(payload.metadata)) fail('invalid_refund_payload', 'Use the immutable saved execution payload.');
      return request('/v1/refunds', { payload });
    },
  };
}
