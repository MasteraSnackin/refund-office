import { validateDemoDataset, demoDatasetDigest } from './demo-dataset.mjs';
const check = (name, passed, explanation) => ({ name, score: passed ? 1 : 0, label: passed ? 'pass' : 'fail', explanation });
export const RUNTIME_EVALUATION_EXPLANATIONS = Object.freeze({
  case_identity: 'The saved case, order and revision belong to this committed synthetic scenario.',
  expected_outcome: 'The saved outcome agrees with the independently committed expectation.',
  exact_amount: 'The recommended amount in integer pence agrees with the expectation.',
  item_and_quantity: 'A positive proposal identifies a real missing order line and its exact catalogue value; a zero proposal identifies no line.',
  evidence_references: 'Every citation belongs to this saved case and expected source records; positive proposals cite packing. This does not establish source authenticity.',
  policy_stop: 'Saved database checks permit an eligible recommendation, or keep an unsupported claim at Review.',
  human_approval_boundary: 'Investigation leaves approval absent and stops before payment or a new reservation.',
  historical_receipt_boundary: 'Only the exact labelled historical fixture can supply a saved receipt or operation.',
  saved_investigation: 'A finished investigation event is persisted with the saved case outcome.',
  actual_trace_binding: 'A completed actual investigation span agrees with this case, pack, revision, amount and outcome.',
});
export function scoreRuntimeCase({ dataset, scenario, caseRecord: c = {}, spans = [] }) {
  const seed = dataset.cases.find(x => x.id === scenario.caseId), order = dataset.orders.find(x => x.id === seed?.orderId);
  if (!seed || !order) throw new Error('A committed case and order expectation are required.');
  const p = c.proposal || {}, positive = scenario.expectedAmountMinor > 0;
  const line = order.lines.find(x => x.id === p.lineId), refs = p.evidenceIds;
  const expectedRefs = new Set(['order', 'packing', 'delivery', 'remedies'].map(kind => `${kind}:${order.id}`).concat(`complaint:${seed.id}`));
  const evidence = new Set((c.evidence || []).map(x => x.id));
  const historical = scenario.expectedOutcome === 'already-resolved';
  const prior = dataset.seedOperations.find(x => x.orderId === order.id && x.lineId === p.lineId);
  const historyOK = historical ? Boolean(prior && c.operationId === prior.id && c.receipt?.seeded === true && c.receipt.id === prior.receipt.id && c.receipt.operationId === prior.id && c.receipt.amountMinor === prior.amountMinor && c.receipt.currency === 'gbp' && c.receipt.status === 'succeeded') : !c.operationId && !c.receipt;
  const checks = Array.isArray(c.checks) ? c.checks : [];
  const roots = spans.filter(x => x.name === 'refund.investigation' && x.attributes?.packId === dataset.id && x.attributes?.caseId === seed.caseId);
  const trace = roots.length === 1 ? roots[0] : null;
  const traceOK = trace?.status === 'OK' && /^[a-f0-9]{32}$/.test(trace.traceId) && /^[a-f0-9]{16}$/.test(trace.spanId) && trace.attributes.synthetic === true && trace.attributes['case.revision'] === c.revision && trace.attributes.amountMinor === c.proposedAmountMinor && trace.attributes.outcome === c.outcome;
  const predicates = {
    case_identity: c.id === seed.id && c.caseId === seed.caseId && c.orderId === order.id && Number.isSafeInteger(c.revision) && c.revision > 0,
    expected_outcome: c.outcome === scenario.expectedOutcome,
    exact_amount: c.proposedAmountMinor === scenario.expectedAmountMinor,
    item_and_quantity: positive ? Boolean(line && p.issue === 'item_missing' && line.ordered > line.packed && p.amountMinor === (line.ordered - line.packed) * line.unitAmountMinor && p.amountMinor === scenario.expectedAmountMinor) : p.amountMinor === 0 && p.lineId === null,
    evidence_references: Array.isArray(refs) && new Set(refs).size === refs.length && refs.every(x => evidence.has(x) && expectedRefs.has(x)) && (!positive || refs.includes(`packing:${order.id}`)),
    policy_stop: historical || (c.stage === 'review' && checks.length >= 7 && (scenario.expectedOutcome === 'awaiting-approval' ? checks.every(x => x.pass === true) && c.proposedAmountMinor <= dataset.policy.limitMinor : checks.some(x => x.pass !== true))),
    human_approval_boundary: c.approval === null && c.stage === (historical ? 'archive' : 'review'),
    historical_receipt_boundary: historyOK,
    saved_investigation: Array.isArray(c.events) && c.events.some(x => x.type === 'investigation.finished' && x.payload?.outcome === c.outcome),
    actual_trace_binding: Boolean(traceOK),
  };
  const evaluations = Object.entries(RUNTIME_EVALUATION_EXPLANATIONS).map(([name, explanation]) => check(name, predicates[name], explanation));
  return { caseId: seed.id, caseLabel: seed.caseId, orderId: order.id, category: scenario.category, revision: c.revision,
    expectedOutcome: scenario.expectedOutcome, observedOutcome: c.outcome || 'missing', expectedAmountMinor: scenario.expectedAmountMinor, observedAmountMinor: c.proposedAmountMinor,
    evidenceRefs: Array.isArray(refs) ? [...refs] : [], failedPolicyChecks: checks.filter(x => x.pass !== true).map(x => x.id),
    analyser: p.provenance || { provider: p.source || 'unknown', mode: p.source === 'local' ? 'local-rules' : 'unknown' },
    traceId: trace?.traceId || null, spanId: trace?.spanId || null, evaluations, passed: evaluations.every(x => x.score === 1) };
}
export function buildRuntimeScorecard({ dataset: input, observations, spans, counters, recorder }) {
  const dataset = validateDemoDataset(input), byId = new Map(observations.map(x => [x.id, x]));
  const cases = dataset.scenarios.map(scenario => scoreRuntimeCase({ dataset, scenario, caseRecord: byId.get(scenario.caseId), spans }));
  const checks = [
    check('complete_case_coverage', observations.length === dataset.cases.length && byId.size === dataset.cases.length && dataset.cases.every(x => byId.has(x.id)), 'Every expected case was independently read back exactly once.'),
    check('intake_replay', counters.intakeReplays === dataset.cases.length && counters.caseCount === dataset.cases.length, 'Replaying each seeded intake returns its existing case and creates no additional cases.'),
    ...['externalRequests', 'approvals', 'newOperations', 'paymentExecutions'].map(name => check(name, counters[name] === 0, `The runner observed zero ${name}.`)),
    check('complete_trace_capture', recorder.recordingErrors === 0 && recorder.writeErrors === 0 && recorder.droppedSpans === 0 && cases.every(x => x.traceId && x.spanId), 'All investigations have retained completed spans, without recorder loss.'),
  ];
  return { schemaVersion: 1, kind: 'refund-office-runtime-scorecard', synthetic: true, uploaded: false,
    runtime: 'actual-createRuntimeService-local-postgresql', analyser: 'local-rules', dataset: { id: dataset.id, digest: demoDatasetDigest(dataset), cases: dataset.cases.length },
    cases, checks, counters, passed: cases.every(x => x.passed) && checks.every(x => x.score === 1),
    summary: { cases: cases.length, passed: cases.filter(x => x.passed).length, failed: cases.filter(x => !x.passed).length, checks: cases.reduce((n,x) => n + x.evaluations.length, checks.length) },
    limitations: ['These are actual current application investigations against a fresh local PostgreSQL database, using synthetic expected outcomes.', 'The runner uses deterministic local analysis. Controlled model responses in separate tests establish contracts, not real model accuracy.', 'No human approval, new payment reservation or payment execution is requested in the evaluated tenants. Historical receipts are labelled fixtures.', 'The database harness also checks disabled approval reservations in separate disposable fixtures; those fixtures are not part of these evaluated cases.', 'Intake replay and existing remedies are checked here; concurrent approval, payment retries and provider recovery have separate tests.', 'Identity is a local test profile. Supabase authentication, cloud deployment, model accounts and Arize ingestion remain unverified.', 'Trace metadata excludes customer statements, source references and secrets. Local files are not proof of a hosted upload.'] };
}
export function prepareRuntimeEvaluationRows(scorecards, spans) {
  if (!Array.isArray(scorecards) || !scorecards.length || !Array.isArray(spans) || spans.length > 4096) throw new Error('Supply bounded current-runtime scorecards and actual spans.');
  const index = new Map(), used = new Set(), rows = [];
  for (const span of spans) {
    const key = `${span.traceId}:${span.spanId}`;
    if (index.has(key) || !/^[a-f0-9]{32}$/.test(span.traceId || '') || !/^[a-f0-9]{16}$/.test(span.spanId || '')) throw new Error('Recorded trace identities must be valid and unique.');
    index.set(key, span);
  }
  for (const pack of scorecards) {
    if (pack.kind !== 'refund-office-runtime-scorecard' || pack.synthetic !== true || pack.uploaded !== false || !['focused-12','busy-50'].includes(pack.dataset?.id) || pack.cases?.length !== pack.dataset.cases) throw new Error('Use complete current-runtime synthetic scorecards.');
    for (const item of pack.cases) {
      const span = index.get(`${item.traceId}:${item.spanId}`);
      if (used.has(item.spanId) || !span || span.name !== 'refund.investigation' || span.status !== 'OK' || span.attributes.synthetic !== true || span.attributes.packId !== pack.dataset.id || span.attributes.caseId !== item.caseLabel || span.attributes['case.revision'] !== item.revision || span.attributes.amountMinor !== item.observedAmountMinor || span.attributes.outcome !== item.observedOutcome) throw new Error('Evaluation does not match the actual recorded investigation.');
      used.add(item.spanId);
      if (item.evaluations?.length !== Object.keys(RUNTIME_EVALUATION_EXPLANATIONS).length || new Set(item.evaluations.map(x => x.name)).size !== item.evaluations.length) throw new Error('Supply every fixed evaluation once.');
      const row = { 'context.span_id': item.spanId };
      for (const e of item.evaluations) {
        if (![0,1].includes(e.score) || e.label !== (e.score ? 'pass' : 'fail') || !Object.hasOwn(RUNTIME_EVALUATION_EXPLANATIONS,e.name) || e.explanation !== RUNTIME_EVALUATION_EXPLANATIONS[e.name]) throw new Error('Evaluation values or explanations were altered.');
        for (const key of ['score','label','explanation']) row[`eval.${e.name}.${key}`] = e[key];
      }
      rows.push(row);
    }
  }
  return { schemaVersion: 1, format: 'arize-evaluation-dataframe-rows', synthetic: true, uploaded: false, runtime: 'actual-createRuntimeService-local-postgresql', rows };
}
