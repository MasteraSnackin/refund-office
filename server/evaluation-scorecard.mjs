import { validateDemoDataset, demoDatasetDigest } from './demo-dataset.mjs';

const outcomes = new Set(['awaiting-approval', 'held', 'already-resolved']);
const traceId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
const spanId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value) ? value : null;
const check = (name, passed, explanation) => ({ name, score: passed ? 1 : 0, label: passed ? 'pass' : 'fail', explanation });

export const EVALUATION_EXPLANATIONS = Object.freeze({
  "case_identity": "The observation must belong to the expected case and order, with a saved revision.",
  "expected_outcome": "The saved outcome must match the committed scenario expectation.",
  "exact_amount": "Compare integer pence with the committed expected amount.",
  "item_and_quantity": "A positive proposal must match an existing missing item and its quantity and price; an unsupported proposal must be zero with no item.",
  "evidence_references": "Citations must exist in this case and its expected source records; a positive proposal must cite packing evidence. This does not prove the source is true.",
  "policy_stop": "An eligible recommendation must pass all saved checks and the limit; a held case must remain at Review with a failed check.",
  "human_approval_boundary": "Investigation must not record approval or enter a new payment stage.",
  "historical_receipt_boundary": "Only an exact, labelled historical fixture may supply a receipt; other investigated cases must have no operation or receipt."
});

// Compare saved observations with an independent, committed synthetic expectation.
// Never use the expected outcome to drive the investigation being measured.
export function scoreObservedCase({ dataset, scenario, caseRecord, traceContext = {} }) {
  const seed = dataset.cases.find(item => item.id === scenario.caseId);
  const order = dataset.orders.find(item => item.id === seed?.orderId);
  if (!seed || !order || !outcomes.has(scenario.expectedOutcome) || !Number.isSafeInteger(scenario.expectedAmountMinor)) throw new Error('A complete synthetic expectation is required.');
  const actual = caseRecord || {}, proposal = actual.proposal || {};
  const evidence = Array.isArray(actual.evidence) ? actual.evidence : [];
  const known = new Set(evidence.map(item => item.id));
  const expectedRefs = new Set(['order', 'packing', 'delivery', 'remedies'].map(kind => `${kind}:${order.id}`).concat(`complaint:${seed.id}`));
  const refs = proposal.evidenceIds;
  const citationOK = Array.isArray(refs) && refs.every(ref => typeof ref === 'string' && known.has(ref) && expectedRefs.has(ref))
    && (scenario.expectedAmountMinor === 0 || refs.includes(`packing:${order.id}`));
  const line = order.lines.find(item => item.id === proposal.lineId);
  const itemOK = scenario.expectedAmountMinor === 0
    ? proposal.amountMinor === 0 && proposal.lineId === null
    : Boolean(line && proposal.issue === 'item_missing' && line.ordered > line.packed &&
      proposal.amountMinor === (line.ordered - line.packed) * line.unitAmountMinor && proposal.amountMinor === scenario.expectedAmountMinor);
  const history = dataset.seedOperations.find(item => item.orderId === order.id && item.lineId === proposal.lineId);
  const historical = scenario.expectedOutcome === 'already-resolved';
  const historyOK = historical
    ? Boolean(history && actual.operationId === history.id && actual.receipt?.seeded === true &&
      actual.receipt.id === history.receipt.id && actual.receipt.operationId === history.id &&
      actual.receipt.amountMinor === history.amountMinor && actual.receipt.currency === 'gbp' && actual.receipt.status === 'succeeded')
    : !actual.receipt && !actual.operationId;
  const approvalOK = (!actual.approval || actual.approval.state === 'required') &&
    (historical ? actual.stage === 'archive' : actual.stage === 'review') &&
    (scenario.expectedOutcome !== 'awaiting-approval' || actual.approval?.state === 'required');
  const checks = Array.isArray(actual.checks) ? actual.checks : [];
  const policyOK = scenario.expectedOutcome === 'awaiting-approval'
    ? checks.length > 0 && checks.every(item => item.status === 'pass') && actual.proposedAmountMinor <= dataset.policy.limitMinor
    : historical || (actual.stage === 'review' && checks.some(item => ['hold', 'blocked'].includes(item.status)));
  const evaluations = [
    check('case_identity', actual.id === seed.id && actual.orderId === order.id && Number.isSafeInteger(actual.revision) && actual.revision > 0, EVALUATION_EXPLANATIONS.case_identity),
    check('expected_outcome', actual.outcome === scenario.expectedOutcome, EVALUATION_EXPLANATIONS.expected_outcome),
    check('exact_amount', Number.isSafeInteger(actual.proposedAmountMinor) && actual.proposedAmountMinor === scenario.expectedAmountMinor, EVALUATION_EXPLANATIONS.exact_amount),
    check('item_and_quantity', itemOK, EVALUATION_EXPLANATIONS.item_and_quantity),
    check('evidence_references', citationOK, EVALUATION_EXPLANATIONS.evidence_references),
    check('policy_stop', policyOK, EVALUATION_EXPLANATIONS.policy_stop),
    check('human_approval_boundary', approvalOK, EVALUATION_EXPLANATIONS.human_approval_boundary),
    check('historical_receipt_boundary', historyOK, EVALUATION_EXPLANATIONS.historical_receipt_boundary),
  ];
  return { caseId: seed.id, caseLabel: seed.caseId, category: scenario.category,
    revision: Number.isSafeInteger(actual.revision) && actual.revision > 0 ? actual.revision : null,
    expectedOutcome: scenario.expectedOutcome, observedOutcome: outcomes.has(actual.outcome) ? actual.outcome : 'unexpected-or-missing',
    expectedAmountMinor: scenario.expectedAmountMinor,
    observedAmountMinor: Number.isSafeInteger(actual.proposedAmountMinor) && actual.proposedAmountMinor >= 0 && actual.proposedAmountMinor <= order.totalMinor ? actual.proposedAmountMinor : null,
    traceId: traceId(traceContext.traceId), spanId: spanId(traceContext.spanId),
    passed: evaluations.every(item => item.score === 1), evaluations };
}

export function buildScorecard({ dataset: input, observations, counters, traceStatus }) {
  const dataset = validateDemoDataset(input);
  if (!Array.isArray(observations)) throw new Error('Supply the observed case results.');
  const matched = new Map(), duplicates = new Set();
  for (const item of observations) {
    if (matched.has(item?.caseRecord?.id)) duplicates.add(item.caseRecord.id);
    matched.set(item?.caseRecord?.id, item);
  }
  const results = dataset.scenarios.map(scenario => scoreObservedCase({ dataset, scenario, ...matched.get(scenario.caseId) }));
  const coverage = observations.length === dataset.cases.length && duplicates.size === 0 && matched.size === dataset.cases.length && dataset.cases.every(item => matched.has(item.id));
  const zero = key => Number.isSafeInteger(counters?.[key]) && counters[key] === 0;
  const intakeReplay = counters?.intakeReplays === dataset.cases.length;
  const checks = [
    check('complete_case_coverage', coverage, 'Every expected case must have exactly one observation; omissions, extras and duplicates fail.'),
    check('no_payment_attempts', zero('paymentAttempts'), 'The evaluation runner denied and counted every payment attempt.'),
    check('no_external_requests', zero('externalRequests'), 'The local provider transport denied and counted every external request.'),
    check('no_new_operations', zero('newOperations'), 'The isolated store must contain only its original historical operations.'),
    check('intake_replay', intakeReplay && counters?.caseCount === dataset.cases.length, 'Replaying every seeded intake event must return its existing case without adding cases.'),
    check('complete_trace_capture', traceStatus?.complete === true && results.every(item => item.traceId && item.spanId), 'Each observed investigation must have a completed local trace; capture failures prevent a complete scorecard.'),
  ];
  return { schemaVersion: 1, kind: 'refund-office-synthetic-scorecard', synthetic: true,
    dataset: { id: dataset.id, digest: demoDatasetDigest(dataset), cases: dataset.cases.length },
    analyser: 'local-rules', runtime: 'isolated-sqlite-engine', uploaded: false,
    passed: checks.every(item => item.score === 1) && results.every(item => item.passed),
    summary: { cases: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length,
      checks: checks.length + results.reduce((sum, item) => sum + item.evaluations.length, 0) },
    checks, cases: results,
    limitations: [
      'These are initial synthetic investigations in a fresh in-memory SQLite store, not observations of a cloud or PostgreSQL deployment.',
      'No refund is approved or submitted. Historical receipts were supplied as labelled fixtures.',
      'Intake replay is checked here. Duplicate-payment retry, concurrent workers, stale decisions and provider recovery require their separate workflow tests.',
      'The local analyser uses deterministic rules. No model or LLM judge was called.',
      'Scores compare known synthetic expectations. They do not establish real-world evidence authenticity or live account acceptance.',
      'The reports and traces remain local. Arize ingestion and evaluation attachment have not been verified against an account.',
    ] };
}
