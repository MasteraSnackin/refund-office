const OPEN_STATUSES = new Set(['ready', 'running', 'paused']);
const ATTENTION_STATUSES = new Set(['review', 'pending', 'error']);
const QUEUE_FILTERS = new Set(['decision', 'evidence', 'recovery', 'holds']);
const FILTERS = new Set(['all', 'attention', 'open', 'resolved', ...QUEUE_FILTERS]);

const savedText = value => typeof value === 'string' ? value.trim().slice(0, 600) : '';
const positiveAmount = value => Number.isSafeInteger(value) && value > 0;
const passedCheck = check => check && check.pass !== false && (check.status === 'pass' || check.status === undefined && check.pass === true);
const holdReason = item => (Array.isArray(item.checks) ? item.checks : [])
  .filter(check => check && (['hold', 'blocked'].includes(check.status) || check.pass === false))
  .map(check => savedText(check.detail) || savedText(check.label)).filter(Boolean).join(' ').slice(0, 600);

// Navigation guidance only: these groups grant no permission and never prepare
// a decision, retry or payment. Conflicting/unknown records remain on hold.
export function caseQueue(item = {}, { capabilities, permissions = {} } = {}) {
  if (!item || typeof item !== 'object') item = {};
  const canReview = permissions.review === true;
  const canInvestigate = permissions.investigate === true;
  const runtime = item.runtime === true || capabilities?.runtime === true;
  const recoverable = !runtime || Boolean(item.intakeRequestId);
  const queue = (group, label, reason, nextAction, actionable = false) => ({ group, label, reason, nextAction, actionable });
  const operationRecorded = typeof item.operationId === 'string' && item.operationId.trim().length > 0;
  const paymentExists = operationRecorded || Boolean(item.receipt);
  const reserved = item.outcome === 'approved-not-submitted' || item.status === 'reserved';
  const historical = item.seededRemedy === true || item.receipt?.seeded === true;
  const closed = item.status === 'closed' || item.outcome === 'closed-no-refund';
  const reviewing = item.status === 'review' || item.status === 'paused' && item.stage === 'review';

  if (reserved) {
    if (!operationRecorded || item.receipt || item.approval?.state !== 'approved' || closed || item.intakeStatus === 'error') return queue('holds', 'Saved result needs inspection', 'A matching approved reservation operation is not established by the saved fields.', 'Inspect the saved approval and operation before taking any action.');
    return queue('reserved', reservationLabels(capabilities).label, reservationLabels(capabilities).notice, capabilities?.hosted === true && capabilities?.separateTestExecutionConfigured === true ? 'Inspect the separate execution record for payment status.' : 'Inspect the saved approval and reservation. Submission is disabled.');
  }
  if (historical) {
    if (item.status !== 'complete' || item.receipt?.status !== 'succeeded' || item.approval?.state === 'required' || item.intakeStatus === 'error') return queue('holds', 'Historical record needs inspection', 'The supplied historical remedy has no matching completed case and successful receipt.', 'Inspect the historical record; do not create another refund.', canReview);
    return queue('historical', 'Historical remedy', 'A labelled historical receipt is saved. It is supplied history, not a new refund from this run.', 'Inspect the historical receipt and case history.');
  }
  if (item.approval?.state === 'approved' && !paymentExists) return queue('holds', 'Saved approval needs inspection', 'An approval is recorded without a matching operation or receipt. Investigation recovery and a new decision are not established as available.', 'Inspect the saved approval and case history before taking any action.');
  if (paymentExists && !closed && (['pending', 'error'].includes(item.status) || !['complete', 'running'].includes(item.status))) return queue('holds', 'Payment result needs inspection', savedText(item.summary) || 'A saved operation exists, but its final result is not established here.', 'Inspect the original operation and saved result before another decision.', canReview);
  if (item.status === 'complete') {
    if (item.approval?.state === 'required' || item.outcome === 'awaiting-approval' || item.intakeStatus === 'error' || item.receipt && item.receipt.status !== 'succeeded') return queue('holds', 'Saved state needs inspection', 'The completion, approval or receipt fields disagree.', 'Inspect the case history and saved result.', canReview);
    return queue('resolved', item.outcome === 'already-resolved' ? 'Existing remedy' : 'Completed case', 'The case has a saved completed outcome. Inspect its record for the result.', 'Inspect the saved outcome and history.');
  }
  if (closed) {
    if (paymentExists || item.approval?.state === 'required' || item.outcome === 'awaiting-approval') return queue('holds', 'Saved closure needs inspection', 'The closure conflicts with a saved operation or pending approval.', 'Inspect the closure and saved operation before any further decision.', canReview);
    return queue('resolved', 'Closed without refund', 'A reviewer closed this case. Its evidence and history remain available.', 'Inspect the recorded closure.');
  }
  if (paymentExists && item.status === 'running') return queue('payment', 'Saved operation in progress', 'An original operation is recorded. Its final result must be checked in the saved payment record.', 'Inspect the original operation and saved result.');
  if (item.review?.state === 'awaiting-evidence') return queue('evidence', 'Waiting for evidence', savedText(item.review.note) || 'The saved review is waiting for supporting evidence.', canReview ? capabilities?.evidenceClarification === true ? 'Inspect the request and record a received clarification.' : 'Inspect the evidence request before reopening review.' : 'A reviewer must record the clarification or reopen this case.', canReview);
  if (item.status === 'error' || item.intakeStatus === 'error') return queue('recovery', 'Investigation recovery', savedText(item.summary) || 'The saved investigation stopped after an error.', canInvestigate && recoverable ? 'Inspect the saved error before choosing investigation recovery.' : 'An investigator must inspect and recover this investigation.', canInvestigate && recoverable);
  if (['ready', 'running'].includes(item.status) || item.status === 'paused' && !reviewing) {
    if (item.approval?.state === 'required' || item.outcome === 'awaiting-approval') return queue('holds', 'Saved state needs inspection', 'The investigation state and pending approval disagree. A recommendation is not ready to decide.', 'Inspect the saved investigation and approval fields.', canReview);
    return queue('investigation', item.status === 'running' ? 'Investigation in progress' : item.status === 'paused' ? 'Investigation paused' : 'Queued investigation', savedText(item.summary) || 'The saved investigation has not reached a human decision.', item.status === 'running' ? 'Inspect the investigation as it progresses.' : canInvestigate && recoverable ? 'Inspect the saved request before continuing the investigation.' : 'An investigator handles this request before human review.', canInvestigate && recoverable && item.status !== 'running');
  }
  if (reviewing && item.approval?.state === 'required') {
    const amount = item.approval.amountMinor;
    const checks = Array.isArray(item.checks) ? item.checks : [];
    const complete = positiveAmount(amount) && (item.proposedAmountMinor === undefined || item.proposedAmountMinor === amount)
      && typeof item.approval.fingerprint === 'string' && item.approval.fingerprint.length > 0
      && checks.length > 0 && checks.every(passedCheck) && !paymentExists && (!item.outcome || item.outcome === 'awaiting-approval');
    if (complete) return queue('decision', 'Ready for human decision', 'A saved exact refund proposal is awaiting approval and its recorded checks passed.', canReview ? 'Inspect the evidence and exact amount, then record your decision.' : 'Inspect the recommendation; a reviewer must decide.', canReview);
    return queue('holds', 'Recommendation needs inspection', holdReason(item) || 'The saved amount, approval binding or checks are incomplete or conflicting.', 'Inspect the saved recommendation and checks before a decision.', canReview);
  }
  if (reviewing || item.status === 'pending' || item.outcome === 'held' || item.approval?.state === 'invalidated') return queue('holds', 'Other review hold', holdReason(item) || savedText(item.summary) || 'The saved case is on hold. A supported refund decision has not been established.', canReview ? 'Inspect the hold and choose a supported review action.' : canInvestigate && recoverable && reviewing ? 'Inspect the saved hold before choosing investigation recovery.' : 'Inspect the saved hold; a reviewer must decide the next step.', canReview || canInvestigate && recoverable && reviewing);
  return queue('holds', 'State not recognised', 'The saved state is not recognised. No readiness or successful outcome is inferred.', 'Inspect the saved case and history before taking any action.');
}

export function summariseReviewQueue(cases) {
  const summary = { decision: 0, evidence: 0, recovery: 0, holds: 0 };
  for (const item of cases) {
    const { group } = caseQueue(item);
    if (QUEUE_FILTERS.has(group)) summary[group] += 1;
  }
  return summary;
}

export function nextCaseForRole(cases, { selectedId, capabilities, permissions } = {}) {
  const eligible = item => item?.id !== undefined && item.id !== selectedId && caseQueue(item, { capabilities, permissions }).actionable;
  const current = cases.findIndex(item => item?.id === selectedId);
  const ordered = current < 0 ? cases : [...cases.slice(current + 1), ...cases.slice(0, current)];
  return ordered.find(eligible) || null;
}

export function reservationLabels(capabilities) {
  const separate = capabilities?.hosted === true && capabilities?.separateTestExecutionConfigured === true;
  return separate ? { label: 'Original approval saved', activity: 'Separate execution record', amountSuffix: ' original reservation', progressDetail: 'Inspect execution record', stepTitle: 'Approval saved', panelTitle: 'Original approval and reservation', notice: 'Original approval and reservation saved. Inspect the separate execution record for payment status.' }
    : { label: 'Approved — not submitted', activity: 'Payment submission disabled', amountSuffix: ' reserved · not submitted', progressDetail: 'Payment disabled', stepTitle: 'Reserved only', panelTitle: 'Approved — not submitted', notice: 'Approval recorded. The amount is reserved; no payment was submitted.' };
}

export function caseStatus(item, capabilities) {
  if (item.outcome === 'approved-not-submitted' || item.status === 'reserved') return { label: reservationLabels(capabilities).label, tone: 'warning' };
  if (item.status === 'closed' || item.outcome === 'closed-no-refund') return { label: 'Closed · no refund', tone: 'neutral' };
  if (item.status === 'review' && item.review?.state === 'awaiting-evidence') return { label: 'Awaiting evidence', tone: 'warning' };
  if (item.intakeStatus === 'error') return { label: 'Investigation stopped', tone: 'warning' };
  if (item.approval?.state === 'required') return { label: 'Awaiting approval', tone: 'warning' };
  if (item.status === 'ready') return { label: 'Ready', tone: 'neutral' };
  if (item.status === 'running') return { label: 'In progress', tone: 'working' };
  if (item.status === 'paused') return { label: 'Paused', tone: 'warning' };
  if (item.status === 'pending') return { label: 'Awaiting result', tone: 'warning' };
  if (item.status === 'error') return { label: 'Needs attention', tone: 'warning' };
  if (item.status === 'review') return { label: 'Review needed', tone: 'warning' };
  if (item.outcome === 'already-resolved') return { label: 'Already resolved', tone: 'success' };
  if (item.outcome === 'refunded') return { label: item.receipt?.provider === 'stripe-sandbox' ? 'Sandbox refunded' : 'Demo refunded', tone: 'success' };
  if (item.status === 'complete') return { label: 'Resolved', tone: 'success' };
  return { label: 'Needs attention', tone: 'warning' };
}

export function caseBucket(item) {
  if (item.outcome === 'approved-not-submitted' || item.status === 'reserved') return 'open';
  if (item.status === 'closed' || item.outcome === 'closed-no-refund') return 'resolved';
  if (item.approval?.state === 'required') return 'attention';
  if (ATTENTION_STATUSES.has(item.status)) return 'attention';
  if (OPEN_STATUSES.has(item.status)) return 'open';
  if (item.status === 'complete') return 'resolved';
  return 'attention';
}

export function filterCases(cases, { filter = 'all', query = '' } = {}) {
  const selectedFilter = FILTERS.has(filter) ? filter : 'all';
  const terms = String(query).trim().toLocaleLowerCase('en-GB').split(/\s+/).filter(Boolean);
  return cases.filter(item => {
    if (QUEUE_FILTERS.has(selectedFilter) ? caseQueue(item).group !== selectedFilter : selectedFilter !== 'all' && caseBucket(item) !== selectedFilter) return false;
    if (!terms.length) return true;
    const text = [item.caseId, item.orderId, item.title, item.shortTitle, item.complaint].filter(Boolean).join(' ').toLocaleLowerCase('en-GB');
    return terms.every(term => text.includes(term));
  });
}

export function summariseCases(cases) {
  const summary = { total: cases.length, attention: 0, open: 0, resolved: 0, recordedMinor: 0, recordedCount: 0, localMinor: 0, stripeMinor: 0 };
  const operations = new Set();
  const receiptIds = new Set();
  for (const item of cases) {
    summary[caseBucket(item)] += 1;
    const receipt = item.receipt;
    if (!receipt || receipt.status !== 'succeeded' || !Number.isSafeInteger(receipt.amountMinor) || receipt.amountMinor <= 0) continue;
    if (receipt.seeded === true || item.seededRemedy === true || receipt.operationId === 'seed-remedy-106' || receipt.id === 'DEMO-REMEDY-106' || item.operationId === 'seed-remedy-106') continue;
    const operationId = receipt.operationId || item.operationId;
    const receiptId = receipt.id;
    if (!operationId && !receiptId) continue;
    const duplicate = (operationId && operations.has(operationId)) || (receiptId && receiptIds.has(receiptId));
    if (operationId) operations.add(operationId);
    if (receiptId) receiptIds.add(receiptId);
    if (duplicate) continue;
    summary.recordedMinor += receipt.amountMinor;
    summary.recordedCount += 1;
    if (receipt.provider === 'local') summary.localMinor += receipt.amountMinor;
    if (receipt.provider === 'stripe-sandbox') summary.stripeMinor += receipt.amountMinor;
  }
  return summary;
}
