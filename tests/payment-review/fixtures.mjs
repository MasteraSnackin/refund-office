import { executionFixture } from '../runtime-payments/fixtures.mjs';
export function contextFixture(execution = null) {
  const e = executionFixture();
  if (execution && !execution.authorisation.at) execution = { ...execution, authorisation: { ...execution.authorisation, at: '2026-10-14T12:15:00Z' } };
  return { caseId: e.caseId, tenantId: e.tenantId, caseRevision: 4, eligible: !execution, blockedReason: execution ? 'A test execution is already saved for this case.' : null,
    binding: { operationId: e.operationId, expectedCaseRevision: 4, originalApprovalId: e.originalApproval.id, originalFingerprint: e.authorisation.originalFingerprint, expectedAmountMinor: e.payload.amountMinor,
      orderId: e.mapping.orderId, lineId: e.originalOperation.lineId, paymentAmountMinor: e.mapping.paymentAmountMinor, currency: 'gbp', originalApprovedAt: '2026-10-14T12:00:00Z', originalApprovedBy: e.authorisation.actor }, execution };
}
export function authorisationProps() {
  const e = executionFixture();
  return { scenario: { id: e.caseId, caseId: 'SYN-C001', revision: 4 }, access: { workspace: { id: e.tenantId }, session: { userId: e.authorisation.actor, role: 'reviewer' } }, capabilities: { hosted: true, separateTestExecutionConfigured: true } };
}
