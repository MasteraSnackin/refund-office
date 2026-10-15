import { caseQueue, reservationLabels } from './case-view.js';
import { recordedAmount, recordedText } from './judge-replay.js';

const list = value => Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const saved = value => typeof value === 'string' && value.trim() ? value : null;

// These are labels for saved provenance, never evidence that a configured
// provider was called. Legacy source=local is the existing local-rules record.
export function briefAnalyser(proposal) {
  const source = saved(proposal?.source), provenance = proposal?.provenance;
  if (source === 'local' && (provenance === undefined || provenance?.provider === 'local' && provenance.mode === 'local-rules')) {
    return { provider: 'local', mode: 'local-rules', model: saved(provenance?.model), label: 'Local rules', detail: 'The saved proposal used the bounded local analyser. This is not a model call.' };
  }
  if (['openai', 'anthropic'].includes(source) && provenance?.provider === source && saved(provenance.model)) {
    if (provenance.mode === 'controlled-test') return { provider: source, mode: 'controlled-test', model: provenance.model, label: 'Controlled model response', detail: 'The saved proposal used an injected test response. This does not establish a provider account request or model quality.' };
    if (provenance.mode === 'provider-response') return { provider: source, mode: 'provider-response', model: provenance.model, label: 'Provider response recorded', detail: 'The saved provenance records a provider response. This view does not retrieve a provider receipt or establish model accuracy.' };
  }
  return { provider: source, mode: 'unknown', model: null, label: 'Analyser provenance not established', detail: proposal ? 'The saved proposal has no recognised provenance. Current connection settings do not establish how it was produced.' : 'No saved proposal is available. Connection settings are not evidence of an investigation.' };
}

export function briefPaymentBoundary(item = {}, capabilities = {}) {
  const historical = item.seededRemedy === true || item.receipt?.seeded === true;
  const history = historical ? ' A labelled synthetic historical remedy is attached; it is not a new payment from this run.' : '';
  if (capabilities.hosted === true && capabilities.separateTestExecutionConfigured === true) return `This snapshot contains the original case record. Separate test execution is configured; its execution record and payment outcome are not included here.${history}`;
  if (item.outcome === 'approved-not-submitted' || item.status === 'reserved') return `${reservationLabels(capabilities).notice}${history}`;
  if (historical) return 'A labelled synthetic historical remedy is attached. It is supplied history, not a new payment from this run.';
  if (item.runtime === true || capabilities.runtime === true || capabilities.paymentSubmission === false) return 'Payment submission is disabled in this case workflow. A recommendation or saved approval does not establish a payment.';
  if (item.receipt?.provider === 'local') return 'A local simulated receipt is saved. No real money moved; this view does not rerun the simulation.';
  if (item.receipt?.provider === 'stripe-sandbox') return 'A Stripe sandbox receipt is saved. It concerns test funds; this view does not refresh or independently verify the provider result.';
  return item.operationId || item.receipt ? 'A saved operation or receipt needs inspection. Its payment outcome is not established by this brief.' : 'No payment result is recorded in this snapshot. A recommendation is not a refund.';
}

function briefDecision(item) {
  const approval = item.approval, review = item.review;
  let text = approval?.state === 'approved' ? `Human approval recorded${amount(approval.amountMinor) === null ? '; exact amount not recorded' : ` for ${recordedAmount(approval.amountMinor)}`}.`
    : approval?.state === 'invalidated' ? 'Previous approval invalidated; a fresh human decision is required.'
      : approval?.state === 'required' || item.outcome === 'awaiting-approval' ? 'Awaiting human approval. No approval has been granted in this snapshot.' : 'No current refund approval is recorded.';
  const reviewText = { 'awaiting-evidence': 'Further evidence requested internally. No customer message was sent.', closed: 'Case closed without a refund.', reopened: 'Review reopened; this is not refund approval.' }[review?.state];
  if (reviewText) text += ` ${reviewText}`;
  const decision = approval?.state === 'approved' ? approval : review;
  return { text, actor: saved(decision?.actor), at: saved(decision?.decidedAt || decision?.at), note: saved(decision?.note) };
}

// Pure presentation of one captured case. No expected answers, inferred agent
// thoughts, customer measurements, trace generation or financial actions.
export function buildDemoBrief(item = {}, capabilities = {}) {
  const evidence = list(item.evidence), checks = list(item.checks), events = list(item.events);
  const citedIds = [...new Set((Array.isArray(item.proposal?.evidenceIds) ? item.proposal.evidenceIds : []).filter(id => typeof id === 'string' && id.trim()))];
  const gathered = new Set(evidence.map(entry => entry.id).filter(id => typeof id === 'string'));
  const citations = citedIds.map(id => ({ id, records: evidence.filter(entry => entry.id === id), resolved: gathered.has(id) }));
  const checkRecords = checks.map(entry => ({ ...entry, result: entry.pass === false || ['hold', 'blocked'].includes(entry.status) ? 'Review / blocked' : entry.status === 'pass' || entry.pass === true && entry.status === undefined ? 'Passed' : 'Not checked' }));
  const proposalAmount = amount(item.proposal?.amountMinor), caseAmount = amount(item.proposedAmountMinor);
  const amountMismatch = proposalAmount !== null && caseAmount !== null && proposalAmount !== caseAmount;
  const queue = caseQueue(item, { capabilities });
  return {
    caseId: recordedText(item.caseId), title: recordedText(item.title), revision: Number.isSafeInteger(item.revision) ? item.revision : null,
    status: amountMismatch ? 'Saved amounts need inspection' : queue.label, statusReason: queue.reason,
    amountMinor: proposalAmount ?? caseAmount, amountMismatch,
    reason: recordedText(item.proposal?.reason, 'No investigation recommendation is saved.'),
    decision: briefDecision(item), paymentBoundary: briefPaymentBoundary(item, capabilities),
    analyser: briefAnalyser(item.proposal), evidenceCount: evidence.length,
    citations, unresolvedCitedIds: citedIds.filter(id => !gathered.has(id)), uncitedCount: evidence.filter(entry => !citedIds.includes(entry.id)).length,
    checks: checkRecords, passedChecks: checkRecords.filter(entry => entry.result === 'Passed').length,
    eventCount: events.length, latestEvent: events.at(-1) || null,
    identityBoundary: capabilities.identityMode === 'local-test-profile' ? 'Local test profiles demonstrate role separation; they are not real account sign-in.' : 'Recorded actor fields are shown when available. This brief does not authenticate a reviewer.',
  };
}
