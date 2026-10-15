export const ENABLED = Object.freeze({ REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_PAYMENT_EXECUTION: 'stripe-test', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'stripe-runtime' });
export function executionFixture() {
  const id = '60000000-0000-4000-8000-000000000001', tenantId = '60000000-0000-4000-8000-000000000012';
  const reviewer = '60000000-0000-4000-8000-000000000002', approvalId = '60000000-0000-4000-8000-000000000003';
  const operationId = 'runtime-op-1', caseId = 'runtime-case-1', orderId = 'SYN-ORDER-1', lineId = 'SYN-LINE-1', fingerprint = 'a'.repeat(64);
  const mapping = { accountId: 'acct_Synthetic1', paymentIntentId: 'pi_Synthetic1', orderId, paymentAmountMinor: 6000, currency: 'gbp', livemode: false };
  const idempotencyKey = 'refund-office-stripe-test-' + id;
  const metadata = { runtime_execution_id: id, refund_office_operation_id: operationId, refund_office_order_id: orderId, refund_office_tenant_id: tenantId };
  const payload = { executionId: id, operationId, orderId, lineId, issue: 'item_missing', amountMinor: 2000, currency: 'gbp', accountId: mapping.accountId, paymentIntentId: mapping.paymentIntentId, paymentAmountMinor: mapping.paymentAmountMinor, idempotencyKey, metadata };
  return { id, tenantId, operationId, caseId, mapping, payload, payloadDigest: 'b'.repeat(64), idempotencyKey,
    originalApproval: { id: approvalId, tenant_id: tenantId, case_id: caseId, operation_id: operationId, amount_minor: 2000, fingerprint, snapshot: { order: { totalMinor: 6000 } } },
    originalOperation: { id: operationId, orderId, lineId, issue: 'item_missing', amountMinor: 2000, status: 'reserved', seeded: false, provider: 'local-disabled', submissionEnabled: false, receipt: null, approvalId },
    authorisation: { actor: reviewer, note: 'Synthetic exact execution decision.', caseRevision: 4, originalFingerprint: fingerprint },
    status: 'authorised', fence: 0, leaseActor: null, leaseUntil: null, submittedAt: null, refundId: null, receipt: null, lastError: null, liveVerified: false };
}
export function providerFixture(e, log = [], { status = 'succeeded' } = {}) {
  const refund = () => ({ id: 're_Synthetic1', amount: e.payload.amountMinor, currency: 'gbp', payment_intent: e.mapping.paymentIntentId, metadata: structuredClone(e.payload.metadata), status });
  return {
    async readAccount() { log.push('account:get'); return { id: e.mapping.accountId }; },
    async readPaymentIntent(id) { log.push('payment:get'); return { id, livemode: false, status: 'succeeded', currency: 'gbp', amount: e.mapping.paymentAmountMinor, amount_received: e.mapping.paymentAmountMinor, latest_charge: 'ch_Synthetic1', metadata: { refund_office_order_id: e.mapping.orderId, refund_office_tenant_id: e.tenantId } }; },
    async readCharge(id) { log.push('charge:get'); return { id, payment_intent: e.mapping.paymentIntentId, livemode: false, currency: 'gbp', paid: true, captured: true, amount: e.mapping.paymentAmountMinor, amount_captured: e.mapping.paymentAmountMinor, amount_refunded: 0 }; },
    async createRefund(payload) { log.push('refund:post'); if (JSON.stringify(payload) !== JSON.stringify(e.payload)) throw new Error('Changed payload'); return refund(); },
    async readRefund(id) { log.push('refund:get'); return { ...refund(), id }; },
  };
}
export function repositoryFixture(execution, log = [], { now = Date.now } = {}) {
  const state = structuredClone(execution), actor = '60000000-0000-4000-8000-000000000004';
  const read = () => structuredClone(state);
  const fence = value => { if (value !== state.fence) throw new Error('Stale fence'); };
  const repository = {
    async claimExecution() { log.push('claim'); if (state.submittedAt || !['authorised','claimed'].includes(state.status)) throw new Error('Already submitted'); Object.assign(state, { status: 'claimed', fence: state.fence + 1, leaseActor: actor, leaseUntil: new Date(now() + 30000).toISOString() }); return read(); },
    async beginSubmission(input) { log.push('intent:save'); fence(input.fence); if (state.submittedAt) throw new Error('No resubmission'); Object.assign(state, { submittedAt: new Date(now()).toISOString(), status: 'submitting', leaseUntil: new Date(now() + 120000).toISOString() }); return read(); },
    async readExecution() { log.push('execution:get'); return read(); },
    async saveRefundReference(input) { log.push('reference:save'); fence(input.fence); Object.assign(state, { refundId: input.refund.id, status: 'response-saved' }); return read(); },
    async recordRefundReadback(input) { log.push('readback:save'); fence(input.fence); Object.assign(state, { receipt: structuredClone(input.refund), status: input.refund.status === 'succeeded' ? 'succeeded' : ['failed','canceled'].includes(input.refund.status) ? 'failed' : 'pending', leaseUntil: null }); return read(); },
    async noteExecutionUnknown(input) { log.push('unknown:save'); fence(input.fence); Object.assign(state, { status: 'uncertain', lastError: input.errorCode, leaseUntil: null }); return read(); },
    async claimReconciliation() { log.push('reconcile:claim'); if (!state.refundId) throw new Error('No refund identity'); Object.assign(state, { status: 'reconciling', fence: state.fence + 1, leaseActor: actor, leaseUntil: new Date(now() + 30000).toISOString() }); return read(); },
  };
  return { repository, state };
}
