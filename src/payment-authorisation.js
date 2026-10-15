const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
const statuses = ['authorised', 'claimed', 'submitting', 'uncertain', 'response-saved', 'reconciling', 'pending', 'succeeded', 'failed'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export const paymentMoney = value => positive(value) ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100) : 'Amount unavailable';
export const samePaymentValue = (a, b) => JSON.stringify(a, (_, value) => record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value) === JSON.stringify(b, (_, value) => record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
export const paymentStorageKey = ({ tenantId, userId, role, caseId, runId }) => `refund-office:payment-authorisation:${tenantId}:${userId}:${role}:${caseId}${runId ? ':' + runId : ''}`;

export function validPaymentBinding(binding) {
  return record(binding) && typeof binding.operationId === 'string' && binding.operationId.length > 0
    && positive(binding.expectedCaseRevision) && uuid.test(binding.originalApprovalId || '') && hex.test(binding.originalFingerprint || '')
    && positive(binding.expectedAmountMinor) && positive(binding.paymentAmountMinor) && binding.expectedAmountMinor <= binding.paymentAmountMinor
    && typeof binding.orderId === 'string' && binding.orderId.length > 0 && typeof binding.lineId === 'string' && binding.lineId.length > 0 && binding.currency === 'gbp';
}

export function verifyPaymentExecution(execution, scope, body) {
  const e = execution;
  if (!record(e) || !uuid.test(e.id || '') || e.tenantId !== scope.tenantId || e.caseId !== scope.caseId || !statuses.includes(e.status)
    || !record(e.mapping) || !record(e.payload) || !record(e.authorisation) || !record(e.originalApproval)
    || typeof e.operationId !== 'string' || e.payload.operationId !== e.operationId || e.payload.executionId !== e.id || !positive(e.payload.amountMinor) || e.payload.currency !== 'gbp'
    || !uuid.test(e.originalApproval.id || '') || e.originalApproval.case_id !== e.caseId || e.originalApproval.tenant_id !== e.tenantId
    || e.originalApproval.operation_id !== e.operationId || e.originalApproval.amount_minor !== e.payload.amountMinor || !hex.test(e.authorisation.originalFingerprint || '')
    || e.originalApproval.fingerprint !== e.authorisation.originalFingerprint || !positive(e.authorisation.caseRevision) || !uuid.test(e.authorisation.actor || '')
    || !record(e.payload.metadata) || e.payload.metadata.runtime_execution_id !== e.id || e.payload.metadata.refund_office_tenant_id !== e.tenantId
    || !/^acct_[A-Za-z0-9]{1,100}$/.test(e.mapping.accountId || '') || !/^pi_[A-Za-z0-9]{1,100}$/.test(e.mapping.paymentIntentId || '')
    || e.mapping.currency !== 'gbp' || e.mapping.livemode !== false || !positive(e.mapping.paymentAmountMinor)
    || e.payload.amountMinor > e.mapping.paymentAmountMinor || e.payload.accountId !== e.mapping.accountId || e.payload.paymentIntentId !== e.mapping.paymentIntentId
    || e.payload.orderId !== e.mapping.orderId || !hex.test(e.payloadDigest || '') || e.idempotencyKey !== `refund-office-stripe-test-${e.id}`
    || !Object.hasOwn(e, 'submittedAt') || !(e.submittedAt === null || Number.isFinite(Date.parse(e.submittedAt))) || !Object.hasOwn(e, 'receipt')) {
    throw new Error('The saved test execution could not be verified. Keep the original authorisation and check the saved result.');
  }
  if (body && (e.operationId !== body.operationId || e.originalApproval.id !== body.originalApprovalId || e.authorisation.originalFingerprint !== body.originalFingerprint
    || e.authorisation.caseRevision !== body.expectedCaseRevision || e.payload.amountMinor !== body.expectedAmountMinor
    || e.authorisation.note !== body.note || e.authorisation.actor !== scope.userId || !samePaymentValue(e.mapping, body.mapping))) {
    throw new Error('The saved execution differs from the original authorisation. A new authorisation is blocked.');
  }
  if (['authorised', 'claimed'].includes(e.status) && (e.submittedAt !== null || e.receipt !== null || e.refundId !== null)) throw new Error('The saved execution status is inconsistent. Check the saved result before continuing.');
  if (!['authorised', 'claimed'].includes(e.status) && !e.submittedAt) throw new Error('The saved submission state could not be verified. Check the saved execution.');
  if (e.receipt !== null || ['pending', 'succeeded', 'failed'].includes(e.status)) {
    const receipt = e.receipt;
    const matchingStatus = e.status === 'succeeded' ? receipt?.status === 'succeeded' : e.status === 'failed' ? ['failed', 'canceled'].includes(receipt?.status) : ['pending', 'requires_action'].includes(receipt?.status);
    if (!e.submittedAt || !record(receipt) || !/^re_[A-Za-z0-9]{1,100}$/.test(receipt.id || '') || e.refundId !== receipt.id || !['succeeded', 'failed', 'canceled', 'pending', 'requires_action'].includes(receipt.status)
      || ['pending', 'succeeded', 'failed'].includes(e.status) && !matchingStatus
      || receipt.amount !== e.payload.amountMinor || receipt.currency !== 'gbp' || receipt.payment_intent !== e.mapping.paymentIntentId || !samePaymentValue(receipt.metadata, e.payload.metadata)) {
      throw new Error('The saved provider readback does not establish this payment result. Check the saved execution.');
    }
  }
  return e;
}

export function verifyPaymentContext(value, scope) {
  if (!record(value) || value.caseId !== scope.caseId || value.tenantId !== scope.tenantId || !positive(value.caseRevision) || typeof value.eligible !== 'boolean'
    || !(value.binding === null || validPaymentBinding(value.binding)) || !(value.blockedReason === null || typeof value.blockedReason === 'string')
    || !Object.hasOwn(value, 'execution') || value.eligible && (!value.binding || value.execution !== null || value.binding.expectedCaseRevision !== value.caseRevision)) {
    throw new Error('The payment review details could not be verified. No authorisation is available until they are confirmed.');
  }
  if (value.execution !== null) {
    const e = verifyPaymentExecution(value.execution, scope), binding = value.binding;
    if (!binding || e.operationId !== binding.operationId || e.originalApproval.id !== binding.originalApprovalId || e.authorisation.originalFingerprint !== binding.originalFingerprint
      || e.authorisation.caseRevision !== binding.expectedCaseRevision || e.payload.amountMinor !== binding.expectedAmountMinor || e.payload.orderId !== binding.orderId
      || e.payload.lineId !== binding.lineId || e.mapping.paymentAmountMinor !== binding.paymentAmountMinor) {
      throw new Error('The saved execution does not match the displayed original approval. New authorisation is blocked.');
    }
  }
  return value;
}

export function makePaymentBody(binding, { accountId, paymentIntentId, note }, commandId) {
  if (!validPaymentBinding(binding) || !uuid.test(commandId || '') || !/^acct_[A-Za-z0-9]{1,100}$/.test(accountId) || !/^pi_[A-Za-z0-9]{1,100}$/.test(paymentIntentId)
    || typeof note !== 'string' || note.trim().length < 10 || note.trim().length > 2000) throw new Error('Enter a Stripe test account, a test payment reference and a reason of 10 to 2,000 characters.');
  return { operationId: binding.operationId, expectedCaseRevision: binding.expectedCaseRevision, originalApprovalId: binding.originalApprovalId,
    originalFingerprint: binding.originalFingerprint, expectedAmountMinor: binding.expectedAmountMinor,
    mapping: { accountId, paymentIntentId, orderId: binding.orderId, paymentAmountMinor: binding.paymentAmountMinor, currency: 'gbp', livemode: false }, note: note.trim(), commandId };
}

export function readPaymentCommand(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const body = JSON.parse(raw), binding = { ...body, orderId: body.mapping?.orderId, lineId: 'saved-line', paymentAmountMinor: body.mapping?.paymentAmountMinor, currency: 'gbp' };
    const checked = makePaymentBody(binding, { accountId: body.mapping?.accountId, paymentIntentId: body.mapping?.paymentIntentId, note: body.note }, body.commandId);
    if (!samePaymentValue(body, checked)) throw Error('shape');
    return body;
  } catch { throw new Error('The saved authorisation could not be read safely. New authorisations are blocked; inspect the saved case result.'); }
}

export function describePaymentExecution(execution) {
  return ({
    authorised: ['Authorised — not submitted', 'The exact test authorisation is saved. The separate executor has not recorded a submission.'],
    claimed: ['Executor preparing', 'The separate executor has claimed this authorisation. No submission intent is recorded yet.'],
    submitting: ['Submission recorded — result unknown', 'A submission intent is saved. A provider request may have happened; do not submit again.'],
    uncertain: ['Payment result unresolved', 'The outcome is not confirmed. A new submission is blocked. The executor may inspect an existing refund reference.'],
    'response-saved': ['Refund reference saved — awaiting readback', 'A provider response was saved. Independent retrieval must confirm the refund before it is shown as complete.'],
    reconciling: ['Checking saved refund', 'The executor is retrieving the existing refund. This does not submit a second refund.'],
    pending: ['Stripe test refund pending', 'The saved provider readback reports a pending refund or further action. It is not complete.'],
    succeeded: ['Stripe test refund confirmed', 'The saved independent provider readback matches this exact authorised test refund. No real money moved.'],
    failed: ['Stripe test refund failed or cancelled', 'The saved provider readback reports failure or cancellation. No automatic replacement refund is offered.'],
  })[execution.status];
}
