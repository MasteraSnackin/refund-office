import { createHash, randomUUID } from 'node:crypto';
import { makeCase, blankChecks } from './fixtures.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const money = (minor) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');

export function createEngine({ store, provider }) {
  const caseLocks = new Map();
  const paymentLocks = new Map();
  async function locked(locks, id, action) {
    const prior = locks.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    locks.set(id, next);
    try { return await next; }
    finally { if (locks.get(id) === next) locks.delete(id); }
  }
  function getCase(id) {
    const item = store.getCase(id);
    if (!item) throw new ApiError(404, 'case_not_found', 'That case does not exist.');
    return item;
  }
  function orderFor(item) { return store.orders().find((order) => order.id === item.orderId); }
  function paymentOrderFor(item) {
    const order = orderFor(item);
    const previousPayment = store.operations(order.id).find(operation => operation.receipt?.paymentIntentId);
    if (previousPayment) order.paymentIntentId = previousPayment.receipt.paymentIntentId;
    return order;
  }
  function approvalSnapshot(item) {
    return { caseId: item.id, order: paymentOrderFor(item), orderTotalMinor: item.orderTotalMinor, proposedAmountMinor: item.proposedAmountMinor, complaint: item.complaint, evidence: clone(item.evidence),
      proposal: clone(item.proposal), policy: store.policy(), provider: clone(provider.capabilities()) };
  }
  function invalidateApproval(item, reason) {
    if (item.approval) item.approval = { ...item.approval, state: 'invalidated', invalidatedAt: now(), reason };
  }
  function boundApproval(operation) {
    const approval = operation.approval;
    const snapshot = operation.approvalSnapshot;
    const payload = operation.payload;
    return Boolean(approval?.state === 'approved' && snapshot && payload && approval.operationId === operation.id &&
      approval.actor === 'local-reviewer' && typeof approval.note === 'string' && approval.note.trim().length >= 10 &&
      Number.isFinite(Date.parse(approval.decidedAt)) && approval.fingerprint === fingerprint(snapshot) &&
      approval.amountMinor === operation.amountMinor && approval.orderId === operation.orderId &&
      approval.lineId === operation.lineId && approval.issue === operation.issue && approval.provider === operation.provider &&
      approval.currency === 'gbp' && approval.policyVersion === snapshot.policy?.version && operation.amountMinor <= (snapshot.policy?.limitMinor ?? -1) &&
      snapshot.provider?.payments === operation.provider && snapshot.caseId === approval.caseId &&
      snapshot.proposal?.amountMinor === operation.amountMinor && snapshot.proposal.lineId === operation.lineId && snapshot.proposal.issue === operation.issue &&
      payload.operationId === operation.id && payload.idempotencyKey === operation.idempotencyKey && payload.amountMinor === operation.amountMinor &&
      payload.lineId === operation.lineId && payload.issue === operation.issue && canonical(payload.order) === canonical(snapshot.order));
  }
  function event(item, label, detail, station = item.stage) {
    item.events.push({ id: randomUUID(), at: now(), station, label, detail });
  }
  function save(item) { item.revision += 1; return clone(store.saveCase(item)); }
  function hold(item, reason, status = 'review', outcome = 'held') {
    item.stage = 'review'; item.status = status; item.outcome = outcome; item.summary = reason;
    event(item, status === 'error' ? 'Investigation could not continue' : 'Review needed', reason);
    return save(item);
  }
  function evidenceFor(item, order) {
    const previous = store.operations(order.id);
    return [
      { id: `order:${order.id}`, title: 'Order details', source: `Synthetic order · ${order.id}`, body: `${money(order.totalMinor)} GBP. ${order.lines.map((line) => `${line.id}: ${line.name}, ${line.ordered} ordered at ${money(line.unitAmountMinor)} each`).join('; ')}.` },
      { id: `packing:${order.id}`, title: 'Packing record', source: `Synthetic fulfilment record · PACK-${order.id}`, body: order.lines.map((line) => `${line.id} (${line.name}): ${line.ordered} ordered, ${line.packed} packed`).join('; ') + '.' },
      { id: `delivery:${order.id}`, title: 'Delivery record', source: `Synthetic courier record · ${order.id}`, body: order.delivery.detail },
      { id: `remedies:${order.id}`, title: 'Previous remedies', source: `Durable remedy register · ${order.id}`, body: previous.length ? previous.map((operation) => `${operation.lineId}: ${money(operation.amountMinor)} ${operation.issue}, ${operation.status}; ${operation.receipt?.id || operation.id}${operation.seeded ? ' (seeded synthetic history)' : ''}`).join('; ') : 'No previous refund operation is recorded for this order.' },
      { id: `complaint:${item.id}`, title: 'Customer report', source: `Case submission · ${item.caseId}`, body: item.complaint },
    ];
  }
  function evaluate(item, order, policy) {
    const proposal = item.proposal;
    const line = order.lines.find((entry) => entry.id === proposal?.lineId);
    const missing = line ? line.ordered - line.packed : 0;
    const amount = proposal?.amountMinor;
    const references = proposal?.evidenceIds;
    const sourceIds = new Set(item.evidence.map((entry) => entry.id));
    const evidenceOK = Boolean(line && missing > 0 && !order.delivery.disputed && proposal.issue === 'item_missing' &&
      Array.isArray(references) && references.includes(`packing:${order.id}`) && references.every((id) => sourceIds.has(id)));
    const amountOK = Number.isSafeInteger(amount) && amount > 0 && Boolean(line) && amount === missing * line.unitAmountMinor;
    const previous = evidenceOK && amountOK ? store.previous(order.id, line.id, 'item_missing') : null;
    const used = store.operations(order.id).filter((operation) => operation.status !== 'failed' && operation.id !== item.operationId).reduce((total, operation) => total + operation.amountMinor, 0);
    const balanceOK = amountOK && amount <= order.totalMinor - used;
    const mandateOK = amountOK && amount <= policy.limitMinor;
    const result = (id, label, passed, passDetail, failDetail, failure = 'hold') => ({ id, label, status: passed ? 'pass' : failure, detail: passed ? passDetail : failDetail });
    const unassessed = (id, label, detail = 'No supported refund amount to assess.') => ({ id, label, status: 'not_checked', detail });
    const hasCandidateAmount = Boolean(line && missing > 0 && Number.isSafeInteger(amount) && amount > 0);
    const checks = [
      result('evidence', 'Evidence supports the claim', evidenceOK, `Packing record confirms ${missing} missing ${line?.name || 'item'}.`, order.delivery.disputed ? 'Delivery scan and customer report conflict. Request delivery evidence.' : 'A supported missing item and valid packing evidence are required.'),
      hasCandidateAmount ? result('amount', 'Amount matches the missing item', amountOK, `${money(amount)} equals the evidenced missing quantity and price.`, 'The proposed amount must exactly match the evidenced missing item.') : unassessed('amount', 'Amount matches the missing item'),
      amountOK ? result('mandate', 'Within the refund policy limit', mandateOK, `${money(amount)} is within policy v${policy.version}: ${money(policy.limitMinor)}.`, `${money(amount)} exceeds policy v${policy.version}'s ${money(policy.limitMinor)} refund policy limit. Approval cannot override this limit.`) : unassessed('mandate', 'Within the refund policy limit'),
      evidenceOK && amountOK ? result('previous', 'No previous remedy', !previous, 'No operation exists for this order, line and issue.', `An existing ${previous?.status || ''} operation covers this issue. No new refund will be created.`, 'blocked') : unassessed('previous', 'No previous remedy', 'A supported order line and issue are needed before checking prior remedies.'),
      amountOK ? result('balance', 'Refundable balance is available', balanceOK, `${money(Math.max(0, order.totalMinor - used))} remains available.`, 'The order does not have enough unreserved refundable balance.', 'blocked') : unassessed('balance', 'Refundable balance is available'),
    ];
    const detail = (id) => checks.find((check) => check.id === id).detail;
    let reason;
    if (!evidenceOK) reason = proposal?.issue !== 'item_missing' && typeof proposal?.reason === 'string' && proposal.reason.trim() ? proposal.reason.trim() : detail('evidence');
    else if (!amountOK) reason = hasCandidateAmount ? detail('amount') : 'The investigation did not establish a supported refund amount. Review the request and evidence.';
    else if (!mandateOK) reason = detail('mandate');
    else if (!balanceOK) reason = detail('balance');
    else if (previous) reason = detail('previous');
    else reason = 'All required refund checks passed.';
    if (reason.length > 280) reason = `${reason.slice(0, 277).replace(/\s+\S*$/, '')}…`;
    return { checks, previous, reason, identifiedIssue: evidenceOK && amountOK ? { lineId: line.id, issue: 'item_missing' } : null,
      authorised: evidenceOK && amountOK && mandateOK && balanceOK && !previous };
  }
  function finishExisting(item, operation) {
    item.operationId = operation.id;
    if (operation.receipt) item.receipt = operation.receipt;
    if (operation.status === 'succeeded') {
      item.stage = 'archive'; item.status = 'complete'; item.outcome = 'already-resolved';
      item.summary = `An existing ${money(operation.amountMinor)} remedy covers this issue. No additional refund was created.`;
      event(item, 'Already resolved', item.summary);
      return save(item);
    }
    if (operation.status === 'failed') return hold(item, 'The existing refund operation failed. It remains recorded for manual review; no automatic replacement was issued.', 'error', 'failed');
    item.stage = 'payments'; item.status = 'pending'; item.outcome = 'pending';
    item.summary = 'A refund operation already exists for this issue. Check its status before any further action.';
    event(item, 'Existing operation awaiting confirmation', item.summary);
    return save(item);
  }
  function applyReceipt(item, operation, receipt) {
    if (!receipt || typeof receipt.id !== 'string' || !receipt.id || receipt.provider !== operation.provider || receipt.livemode === true || receipt.amountMinor !== operation.amountMinor ||
      receipt.currency?.toLowerCase() !== 'gbp' || receipt.operationId !== operation.id ||
      !['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(receipt.status)) {
      throw new Error('The provider returned an unverified refund result.');
    }
    operation.receipt = receipt;
    operation.status = receipt.status === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(receipt.status) ? 'failed' : 'pending';
    operation.updatedAt = now();
    delete operation.lastError;
    store.saveOperation(operation);
    item.receipt = receipt;
    if (operation.status === 'succeeded') {
      item.stage = 'archive'; item.status = 'complete'; item.outcome = 'refunded';
      item.summary = receipt.provider === 'local' ? `${money(receipt.amountMinor)} local demo refund recorded. No real money moved.` : `${money(receipt.amountMinor)} Stripe sandbox refund confirmed. No real money moved.`;
      event(item, receipt.provider === 'local' ? 'Local demo refund recorded' : 'Sandbox refund confirmed', `${item.summary} Receipt: ${receipt.id}.`);
      return save(item);
    }
    if (operation.status === 'failed') return hold(item, `The payment provider reports ${receipt.status}. No successful refund is claimed. Keep this operation for review.`, 'error', 'failed');
    item.stage = 'payments'; item.status = 'pending'; item.outcome = 'pending';
    item.summary = `The provider reports ${receipt.status}. The refund is not yet confirmed; check this same operation again.`;
    event(item, 'Refund awaiting confirmation', item.summary);
    return save(item);
  }
  async function execute(item, reconcile = false) {
    const operationId = item.operationId;
    return locked(paymentLocks, operationId, async () => {
      let operation = store.operation(operationId);
      if (!operation) return hold(item, 'The saved refund operation is missing. Review is required.', 'error', 'failed');
      if (operation.status === 'succeeded' || operation.status === 'failed') return finishExisting(item, operation);
      try {
        let receipt;
        if (reconcile || operation.status === 'pending') {
          if (!operation.receipt?.id && (!operation.submittedAt || !boundApproval(operation))) {
            item.stage = 'payments'; item.status = 'pending'; item.outcome = 'pending';
            item.summary = 'The saved payment result is unconfirmed. Without a receipt or recorded approval, this operation cannot be resubmitted. Inspect the original provider record.';
            event(item, 'Reconciliation requires original provider evidence', item.summary);
            return save(item);
          }
          receipt = await provider.retrieveRefund({ receipt: operation.receipt || null, operation: clone(operation) });
        } else {
          if (!boundApproval(operation) || item.approval?.state !== 'approved' || item.approval.operationId !== operation.id || item.approval.fingerprint !== operation.approval.fingerprint) {
            invalidateApproval(item, 'A valid approval bound to this refund operation is required.');
            return hold(item, 'Human approval is required before this saved operation can be submitted. Investigate again to request approval for the exact refund.');
          }
          if (fingerprint(approvalSnapshot(item)) !== operation.approval.fingerprint) {
            invalidateApproval(item, 'The approved case facts, policy or provider have changed.');
            return hold(item, 'The approved case facts, policy or provider changed before submission. No refund was submitted. Investigate again and request fresh approval.');
          }
          const currentPolicy = store.policy();
          item.policySnapshot = currentPolicy;
          item.checks = evaluate(item, orderFor(item), currentPolicy).checks.map((check) => check.id === 'previous' ? { ...check, status: 'pass', detail: 'This case owns the reserved operation; it has not been submitted.' } : check);
          if (item.checks.some((check) => check.status !== 'pass')) {
            invalidateApproval(item, 'A required refund check changed before submission.');
            return hold(item, 'A required authorisation check changed before submission. The reserved operation was not sent. Investigate again before requesting approval.');
          }
          operation.executionPolicy = currentPolicy;
          operation.status = 'pending'; operation.submittedAt = now();
          store.saveOperation(operation);
          receipt = await provider.createRefund(clone(operation.payload));
        }
        return applyReceipt(item, operation, receipt);
      } catch (error) {
        operation = store.operation(operationId);
        operation.status = 'pending'; operation.updatedAt = now();
        operation.lastError = { code: error.code || 'provider_result_unverified', message: error.code ? error.message : 'The provider result could not be verified.' };
        store.saveOperation(operation);
        item.stage = 'payments'; item.status = 'pending'; item.outcome = 'pending';
        item.summary = `${operation.lastError.message} The original operation is preserved; check its status before proceeding.`;
        event(item, 'Provider result unresolved', item.summary);
        return save(item);
      }
    });
  }

  function checkIntakeOwner(item, requestId) {
    const request = store.intakeRequest(requestId);
    if (!request || request.caseId !== item.id || !item.intakeManaged || item.intakeRequestId !== request.id) throw new ApiError(409, 'intake_not_owner', 'Only the intake request that owns this case can investigate it.');
  }
  function checkIntakeBoundary(item, allowError = false) {
    if (item.operationId || item.receipt || item.approval?.state === 'approved' || item.stage === 'payments' || item.status === 'pending') throw new ApiError(409, 'intake_payment_boundary', 'Intake stops before payment. A reviewer must handle this saved operation.');
    const allowedStage = ['reception', 'evidence', 'policy'].includes(item.stage);
    const safeError = allowError && item.status === 'error' && item.stage === 'review';
    if (!allowedStage && !safeError) throw new ApiError(409, 'intake_review_boundary', 'The intake investigation has stopped for review. It cannot approve or reopen this case automatically.');
  }

  async function advanceSaved(item, input) {
      if (!input || !Number.isSafeInteger(input.expectedRevision)) throw new ApiError(400, 'revision_required', 'Provide the case revision to advance.');
      if (item.revision !== input.expectedRevision) throw new ApiError(409, 'stale_revision', 'This case has changed. Refresh its saved state before continuing.');
      if (item.status !== 'running') throw new ApiError(409, 'case_not_running', 'Only a running case can advance.');
      const order = orderFor(item);
      if (item.stage === 'reception') {
        item.evidence = evidenceFor(item, order); item.stage = 'evidence';
        item.summary = 'Order, packing, delivery and prior-remedy records retrieved. Investigating the customer request.';
        event(item, 'Evidence retrieved', `Loaded ${item.evidence.length} records for ${order.id}.`);
        return save(item);
      }
      if (item.stage === 'evidence') {
        try {
          const proposal = await provider.proposeCase({ complaint: item.complaint, order, evidence: clone(item.evidence) });
          item.proposal = proposal && typeof proposal === 'object' ? {
            amountMinor: Number.isSafeInteger(proposal.amountMinor) ? proposal.amountMinor : 0,
            lineId: typeof proposal.lineId === 'string' ? proposal.lineId.slice(0, 100) : null,
            issue: typeof proposal.issue === 'string' ? proposal.issue.slice(0, 100) : 'unknown',
            reason: typeof proposal.reason === 'string' ? proposal.reason.slice(0, 4000) : 'No reason was supplied.',
            evidenceIds: Array.isArray(proposal.evidenceIds) ? proposal.evidenceIds.filter((entry) => typeof entry === 'string').slice(0, 30) : [],
            source: ['openai', 'anthropic'].includes(proposal.source) ? proposal.source : 'local',
          } : null;
          item.proposedAmountMinor = Number.isSafeInteger(proposal?.amountMinor) && proposal.amountMinor >= 0 ? proposal.amountMinor : 0;
          item.stage = 'policy';
          item.summary = typeof proposal?.reason === 'string' ? proposal.reason : 'No supported proposal was returned. Policy checks will determine whether review is required.';
          event(item, 'Investigation proposal recorded', `${proposal?.source === 'openai' ? 'OpenAI' : proposal?.source === 'anthropic' ? 'Anthropic' : 'Local analyser'}: ${item.summary}`);
          return save(item);
        } catch (error) {
          return hold(item, `${error.code ? error.message : 'The analyser could not complete the investigation.'} No refund was authorised.`, 'error', 'failed');
        }
      }
      if (item.stage === 'policy') {
        return store.transaction(() => {
          const policy = store.policy();
          const evaluation = evaluate(item, order, policy);
          item.checks = evaluation.checks; item.policySnapshot = policy;
          event(item, 'Policy checked', `Policy v${policy.version}, refund policy limit ${money(policy.limitMinor)}. Human approval is also required before every new refund.`);
          const ownReservation = evaluation.previous && evaluation.previous.id === item.operationId && evaluation.previous.status === 'reserved' && !evaluation.previous.submittedAt;
          if (ownReservation) {
            item.checks = item.checks.map((check) => check.id === 'previous' ? { ...check, status: 'pass', detail: 'This case owns the saved operation. It has not been submitted.' } : check);
          } else if (evaluation.previous) return finishExisting(item, evaluation.previous);
          if (item.checks.some(check => check.status !== 'pass')) {
            return hold(item, evaluation.reason);
          }
          const snapshot = approvalSnapshot(item);
          item.approval = { state: 'required', fingerprint: fingerprint(snapshot), amountMinor: item.proposal.amountMinor, currency: 'gbp', orderId: item.orderId,
            lineId: item.proposal.lineId, issue: item.proposal.issue, policyVersion: policy.version, provider: snapshot.provider.payments, requestedAt: now() };
          item.stage = 'review'; item.status = 'review'; item.outcome = 'awaiting-approval';
          item.summary = `${money(item.proposal.amountMinor)} passes the refund policy checks. Human approval is required before this refund can be prepared.`;
          event(item, 'Human approval required', item.summary);
          return save(item);
        });
      }
      if (item.stage === 'payments') return execute(item);
      throw new ApiError(409, 'invalid_stage', 'This case cannot advance from its saved stage.');
  }

  return {
    getCase,
    bootstrap() { const demoDataset = store.demoDataset(); return { cases: store.cases(), orders: store.orders(), policy: store.policy(), capabilities: provider.capabilities(), ...(demoDataset ? { demoDataset } : {}) }; },
    createCase(input) {
      if (!input || typeof input.orderId !== 'string' || !store.orders().some((order) => order.id === input.orderId)) throw new ApiError(400, 'invalid_order', 'Choose one of the supplied demo orders.');
      if (typeof input.complaint !== 'string' || input.complaint.trim().length < 8 || input.complaint.trim().length > 4000) throw new ApiError(400, 'invalid_complaint', 'Describe the issue in 8 to 4,000 characters.');
      if (store.cases().length >= 500) throw new ApiError(409, 'case_limit', 'This local demo has reached its 500-case limit.');
      let number = 104 + store.cases().length;
      const usedNumbers = new Set(store.cases().map(item => item.caseId));
      while (usedNumbers.has(`RF-${number}`)) number++;
      return store.saveCase(makeCase({ id: randomUUID(), caseId: `RF-${number}`, title: 'New refund investigation', shortTitle: 'New request', orderId: input.orderId, complaint: input.complaint.trim() }, store.orders()));
    },
    updatePolicy(input) {
      if (!input || !Number.isSafeInteger(input.limitMinor) || input.limitMinor < 0 || input.limitMinor > 100000) throw new ApiError(400, 'invalid_limit', 'The refund limit must be a whole number of pence from 0 to 100,000.');
      const previous = store.policy();
      if (previous.limitMinor === input.limitMinor) return previous;
      return store.savePolicy({ limitMinor: input.limitMinor, version: previous.version + 1 });
    },
    run(id) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      if (item.status === 'closed') throw new ApiError(409, 'case_closed', 'Reopen this case with a recorded reason before investigating it again.');
      if (['running', 'paused', 'pending'].includes(item.status)) throw new ApiError(409, 'case_in_progress', 'Resume or check the existing investigation before starting again.');
      const oldOperation = item.operationId && store.operation(item.operationId);
      if (oldOperation && !['succeeded', 'failed'].includes(oldOperation.status) && oldOperation.submittedAt) throw new ApiError(409, 'operation_unresolved', 'Check the existing payment operation before starting again.');
      item.stage = 'reception'; item.status = 'running'; item.outcome = null; item.evidence = []; item.checks = blankChecks(); item.proposal = null; item.proposedAmountMinor = 0; item.policySnapshot = null;
      item.approval = null;
      if (item.review) item.review = { ...item.review, state: 'open' };
      item.summary = 'The complaint is logged and linked to its supplied order. Retrieving evidence next.';
      event(item, 'Case received', `${item.caseId} linked to ${item.orderId}.`);
      return save(item);
    }); },
    review(id, input) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      if (!input || !['request-evidence', 'close-no-refund', 'reopen'].includes(input.action)) throw new ApiError(400, 'invalid_review_action', 'Choose to record evidence needed, close without refund or reopen the case.');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ApiError(400, 'revision_required', 'Provide the case revision to record a review decision.');
      if (item.revision !== input.expectedRevision) throw new ApiError(409, 'stale_revision', 'This case has changed. Refresh its saved state before recording a review decision.');
      if (typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.trim().length > 1000) throw new ApiError(400, 'invalid_review_note', 'Record a reason in 10 to 1,000 characters.');
      if (item.operationId || item.receipt) throw new ApiError(409, 'payment_operation_exists', 'This case has a saved payment operation or receipt. Inspect or reconcile that operation before any closure decision.');
      const reopening = input.action === 'reopen';
      if (reopening ? item.status !== 'closed' : item.status !== 'review') throw new ApiError(409, 'review_action_unavailable', reopening ? 'Only a closed case can be reopened.' : 'Only a case awaiting review can receive this decision.');
      if (!reopening) {
        const { identifiedIssue } = evaluate(item, orderFor(item), store.policy());
        const relatedOperation = identifiedIssue
          ? store.previous(item.orderId, identifiedIssue.lineId, identifiedIssue.issue)
          : store.operations(item.orderId)[0];
        if (relatedOperation) throw new ApiError(409, 'related_payment_operation_exists', 'Another saved payment operation exists for this order. Inspect its result or investigate this case again before recording a review decision.');
      }
      const note = input.note.trim();
      const decidedAt = now();
      const state = reopening ? 'open' : input.action === 'close-no-refund' ? 'closed' : 'awaiting-evidence';
      invalidateApproval(item, 'A recorded review decision changed the case. Investigate again before requesting approval.');
      item.review = { state, note, decidedAt, actor: 'local-reviewer' };
      if (input.action === 'close-no-refund') {
        item.status = 'closed'; item.outcome = 'closed-no-refund'; item.stage = 'archive';
        item.summary = 'Closed without refund. The review reason is saved in the case history.';
        event(item, 'Closed without refund', `Local reviewer: ${note} No payment operation was created.`, 'review');
      } else if (reopening) {
        item.status = 'review'; item.outcome = 'held'; item.stage = 'review';
        item.summary = 'Case reopened for review. Investigate again to recheck the supplied records and current policy.';
        event(item, 'Case reopened', `Local reviewer: ${note} No refund was authorised.`, 'review');
      } else {
        item.status = 'review'; item.outcome = 'held'; item.stage = 'review';
        item.summary = 'Awaiting evidence. An internal evidence request is recorded; no message has been sent.';
        event(item, 'Evidence needed — internal request recorded', `Local reviewer: ${note} Nothing was sent externally.`, 'review');
      }
      return save(item);
    }); },
    approve(id, input) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ApiError(400, 'revision_required', 'Provide the current case revision to approve a refund.');
      if (item.revision !== input.expectedRevision) throw new ApiError(409, 'stale_revision', 'This case has changed. Refresh its saved state before approving.');
      if (!Number.isSafeInteger(input.expectedAmountMinor) || input.expectedAmountMinor <= 0) throw new ApiError(400, 'invalid_approval_amount', 'Confirm the exact refund amount in whole pence.');
      if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new ApiError(400, 'invalid_approval_fingerprint', 'Provide the saved approval request fingerprint.');
      if (typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.trim().length > 1000) throw new ApiError(400, 'invalid_approval_note', 'Record an approval reason in 10 to 1,000 characters.');
      if (item.status !== 'review' || item.outcome !== 'awaiting-approval' || item.approval?.state !== 'required') throw new ApiError(409, 'approval_not_required', 'Investigate the case to obtain a current approval request first.');
      if (input.expectedAmountMinor !== item.approval.amountMinor || input.fingerprint !== item.approval.fingerprint) throw new ApiError(409, 'approval_mismatch', 'The supplied amount or fingerprint does not match the saved approval request.');
      const result = store.transaction(() => {
        const snapshot = approvalSnapshot(item);
        const changed = reason => {
          invalidateApproval(item, reason);
          hold(item, `${reason} No refund was submitted. Investigate again to request fresh approval.`);
          return { approvalChanged: true };
        };
        if (fingerprint(snapshot) !== item.approval.fingerprint) return changed('The case facts, policy or provider changed after approval was requested.');
        if (item.approval.amountMinor !== snapshot.proposal?.amountMinor || item.approval.amountMinor !== snapshot.proposedAmountMinor ||
          item.approval.orderId !== snapshot.order.id || item.approval.lineId !== snapshot.proposal.lineId || item.approval.issue !== snapshot.proposal.issue ||
          item.approval.currency !== 'gbp' || item.approval.policyVersion !== snapshot.policy.version || item.approval.provider !== snapshot.provider.payments) {
          return changed('The saved approval details do not match the exact refund proposal.');
        }
        const evaluation = evaluate(item, snapshot.order, snapshot.policy);
        item.checks = evaluation.checks; item.policySnapshot = snapshot.policy;
        const existing = evaluation.previous;
        const ownReservation = existing && existing.id === item.operationId && existing.status === 'reserved' && !existing.submittedAt;
        if (existing && !ownReservation) {
          invalidateApproval(item, 'Another operation already covers this issue. No new approval or refund was recorded.');
          return finishExisting(item, existing);
        }
        if (ownReservation) item.checks = item.checks.map(check => check.id === 'previous' ? { ...check, status: 'pass', detail: 'This case owns the saved operation. It has not been submitted.' } : check);
        if (item.checks.some(check => check.status !== 'pass')) return changed('The required refund checks no longer pass. Approval cannot override the refund policy.');
        const operationId = ownReservation ? existing.id : randomUUID();
        const idempotencyKey = ownReservation ? existing.idempotencyKey : `refund-office-${operationId}`;
        const payload = { operationId, idempotencyKey, order: snapshot.order, amountMinor: item.proposal.amountMinor, lineId: item.proposal.lineId, issue: 'item_missing' };
        if (ownReservation && (canonical(existing.payload) !== canonical(payload) || existing.provider !== snapshot.provider.payments)) return changed('The saved operation differs from the current proposal or provider. Restore its original facts before requesting approval.');
        const approval = { ...item.approval, state: 'approved', caseId: item.id, operationId, actor: 'local-reviewer', decidedAt: now(), note: input.note.trim() };
        const operation = ownReservation ? existing : { id: operationId, orderId: item.orderId, lineId: payload.lineId, issue: payload.issue, amountMinor: payload.amountMinor,
          status: 'reserved', provider: snapshot.provider.payments, createdAt: now(), idempotencyKey, payload, receipt: null };
        operation.policySnapshot = snapshot.policy; operation.approval = clone(approval); operation.approvalSnapshot = snapshot;
        store.saveOperation(operation);
        item.approval = approval; item.operationId = operationId; item.stage = 'payments'; item.status = 'running'; item.outcome = null;
        item.summary = `${money(payload.amountMinor)} approved by the local reviewer. The exact operation and approval are saved before payment submission.`;
        event(item, 'Human approval recorded', `${money(payload.amountMinor)} under refund policy v${snapshot.policy.version}. Local reviewer: ${approval.note}`, 'review');
        item.events.at(-1).approval = clone(approval);
        event(item, 'Refund operation reserved', 'The approved operation and its original retry key are saved. Submission will recheck the approved facts.');
        return save(item);
      });
      if (result.approvalChanged) throw new ApiError(409, 'approval_changed', 'The approval request changed and the case returned to Review. Investigate again before approving.');
      return result;
    }); },
    advance(id, input) { return locked(caseLocks, id, () => advanceSaved(getCase(id), input)); },
    advanceIntake(id, requestId) { return locked(caseLocks, id, async () => {
      const item = getCase(id);
      checkIntakeOwner(item, requestId);
      // This gate is checked inside the same lock as human approval and normal
      // advance. Intake has no route to execute() or reconcile(), even after an
      // approval races with a queued background step.
      checkIntakeBoundary(item);
      if (provider.capabilities().analyser !== 'local') throw new ApiError(409, 'intake_offline_required', 'Background intake is available only with the local analyser. External services remain disconnected.');
      if (item.status === 'ready') {
        item.status = 'running'; item.summary = 'The local intake worker is retrieving the supplied evidence.';
        event(item, 'Local intake investigation started', 'Background investigation will stop before any human approval or payment.');
        return save(item);
      }
      if (item.status !== 'running') return item;
      return advanceSaved(item, { expectedRevision: item.revision });
    }); },
    failIntake(id, requestId, message) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      checkIntakeOwner(item, requestId);
      // Record a worker failure only while it still owns active investigation.
      // A pause, review or payment handoff that won the lock stays untouched.
      if (!['ready', 'running'].includes(item.status) || !['reception', 'evidence', 'policy'].includes(item.stage) ||
        item.operationId || item.receipt || item.approval?.state === 'approved') return item;
      const detail = typeof message === 'string' && message ? message.slice(0, 1000) : 'The local intake investigation stopped. Review the saved case before resuming.';
      return hold(item, detail, 'error', 'failed');
    }); },
    resumeIntake(id, requestId) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      checkIntakeOwner(item, requestId);
      checkIntakeBoundary(item, true);
      if (!['paused', 'error'].includes(item.status)) throw new ApiError(409, 'intake_not_resumable', 'Only a paused or failed intake investigation can be resumed.');
      if (item.status === 'error') {
        item.stage = 'reception'; item.outcome = null; item.evidence = []; item.checks = blankChecks();
        item.proposal = null; item.proposedAmountMinor = 0; item.policySnapshot = null; item.approval = null;
      }
      item.status = 'running'; delete item.pauseReason;
      item.summary = 'The local intake investigation is continuing from its saved evidence.';
      event(item, 'Local intake investigation resumed', 'The worker will stop for review. No refund was approved.');
      return save(item);
    }); },
    pause(id) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      if (item.status === 'paused') return item;
      if (item.status !== 'running') throw new ApiError(409, 'case_not_running', 'Only a running case can be paused.');
      item.status = 'paused'; item.pauseReason = 'manual'; event(item, 'Investigation paused', 'Progress is saved. Resume to continue the same investigation.');
      return save(item);
    }); },
    resume(id) { return locked(caseLocks, id, () => {
      const item = getCase(id);
      if (item.status !== 'paused') throw new ApiError(409, 'case_not_paused', 'Only a paused case can resume.');
      if (item.stage === 'payments') {
        const operation = item.operationId && store.operation(item.operationId);
        if (operation && !operation.submittedAt && !boundApproval(operation)) {
          invalidateApproval(item, 'The saved operation has no valid human approval.');
          return hold(item, 'Human approval is required for this saved operation. Investigate again before requesting approval.');
        }
      }
      item.status = 'running'; delete item.pauseReason; event(item, 'Investigation resumed', 'Continuing from the saved stage.');
      return save(item);
    }); },
    reconcile(id) { return locked(caseLocks, id, async () => {
      const item = getCase(id);
      if (!item.operationId || !['pending', 'error'].includes(item.status)) throw new ApiError(409, 'nothing_to_reconcile', 'This case has no unresolved payment operation to check.');
      const operation = store.operation(item.operationId);
      if (!operation?.submittedAt && !operation?.receipt) throw new ApiError(409, 'not_submitted', 'This operation has not been submitted to the provider. Review the policy before continuing.');
      return execute(item, true);
    }); },
    exportCase(id) {
      const item = getCase(id);
      const operation = item.operationId ? store.operation(item.operationId) : null;
      return { schemaVersion: 1, exportedAt: now(), dataMode: 'synthetic-orders', case: item, order: orderFor(item),
        operation: operation ? { id: operation.id, orderId: operation.orderId, lineId: operation.lineId, issue: operation.issue, amountMinor: operation.amountMinor, status: operation.status, provider: operation.provider || operation.receipt?.provider, createdAt: operation.createdAt, submittedAt: operation.submittedAt || null, idempotencyKey: operation.idempotencyKey, policySnapshot: operation.policySnapshot || null, executionPolicy: operation.executionPolicy || null, approval: operation.approval || null, approvalSnapshot: operation.approvalSnapshot || null, seeded: Boolean(operation.seeded), receipt: operation.receipt || null } : null,
        currentPolicy: store.policy(), capabilities: provider.capabilities() };
    },
  };
}
