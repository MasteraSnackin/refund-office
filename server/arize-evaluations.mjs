// Column names follow Arize AX's documented spans.update_evaluations dataframe.
// This builds local input only. It does not install an SDK or contact Arize.
import { EVALUATION_EXPLANATIONS } from './evaluation-scorecard.mjs';
const names = new Set(['case_identity', 'expected_outcome', 'exact_amount', 'item_and_quantity', 'evidence_references', 'policy_stop', 'human_approval_boundary', 'historical_receipt_boundary']);

export function prepareArizeEvaluationRows(scorecards, spans) {
  if (!Array.isArray(scorecards) || !scorecards.length || !Array.isArray(spans) || spans.length > 4096) throw new Error('Supply bounded local scorecards and their recorded spans.');
  const observed = new Map();
  for (const span of spans) {
    const key = `${span.traceId}:${span.spanId}`;
    if (observed.has(key)) throw new Error('Recorded trace identities must be unique.');
    observed.set(key, span);
  }
  const rows = [], used = new Set();
  for (const scorecard of scorecards) {
    if (scorecard?.kind !== 'refund-office-synthetic-scorecard' || scorecard.synthetic !== true || scorecard.uploaded !== false || !['focused-12', 'busy-50'].includes(scorecard.dataset?.id) || !Array.isArray(scorecard.cases) || scorecard.cases.length !== scorecard.dataset.cases) throw new Error('Use a complete locally generated synthetic scorecard.');
    for (const item of scorecard.cases) {
      const span = observed.get(`${item.traceId}:${item.spanId}`);
      if (!/^[a-f0-9]{16}$/.test(item.spanId || '') || used.has(item.spanId) || !span || span.status !== 'OK' || span.name !== 'refund.investigation' || span.attributes?.synthetic !== true || span.attributes?.packId !== scorecard.dataset.id || span.attributes?.caseId !== item.caseLabel) throw new Error('Every evaluation must match its actual recorded synthetic investigation.');
      if (span.attributes.caseRevision !== item.revision || span.attributes.amountMinor !== item.observedAmountMinor || span.attributes.outcome !== item.observedOutcome) throw new Error('The evaluation facts differ from the recorded investigation.');
      used.add(item.spanId);
      if (!Array.isArray(item.evaluations) || item.evaluations.length !== names.size || new Set(item.evaluations.map(e => e.name)).size !== names.size) throw new Error('Supply every expected evaluation exactly once.');
      const row = { 'context.span_id': item.spanId };
      for (const evaluation of item.evaluations) {
        if (!names.has(evaluation.name) || ![0, 1].includes(evaluation.score) || evaluation.label !== (evaluation.score ? 'pass' : 'fail') || evaluation.explanation !== EVALUATION_EXPLANATIONS[evaluation.name]) throw new Error('Only the fixed deterministic evaluation explanations are supported.');
        row[`eval.${evaluation.name}.score`] = evaluation.score;
        row[`eval.${evaluation.name}.label`] = evaluation.label;
        row[`eval.${evaluation.name}.explanation`] = evaluation.explanation;
      }
      rows.push(row);
    }
  }
  return { schemaVersion: 1, format: 'arize-evaluation-dataframe-rows', synthetic: true, uploaded: false, rows,
    limitations: ['Prepared for the documented Arize spans.update_evaluations dataframe; no account acceptance is claimed.',
      'Upload the matching traces first, verify their destination and identifiers, then explicitly authorise attaching these evaluations.',
      'Run-level controls are kept in the local scorecard and are not falsely attached to one investigation span.'] };
}
