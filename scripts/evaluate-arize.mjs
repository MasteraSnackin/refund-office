import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../server/store.mjs';
import { createProviders } from '../server/providers.mjs';
import { createEngine } from '../server/engine.mjs';
import { createIntake } from '../server/intake.mjs';
import { validateDemoDataset } from '../server/demo-dataset.mjs';
import { createLocalObserver } from '../server/observability.mjs';
import { buildScorecard } from '../server/evaluation-scorecard.mjs';
import { prepareArizeEvaluationRows } from '../server/arize-evaluations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = ['focused-12', 'busy-50'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = {
  'focused-12': 'Focused pack', 'busy-50': 'Busy office pack',
  'awaiting-approval': 'Awaiting approval', held: 'Held for review', 'already-resolved': 'Historical remedy',
  'eligible-missing-item': 'Missing item', 'quantity-two-missing': 'Two units missing', 'exact-policy-limit': 'At the policy limit',
  'over-policy-limit': 'Above the policy limit', 'disputed-delivery': 'Delivery disputed', 'all-packed-unsupported': 'Packing contradicts claim',
  'damaged-unsupported-issue': 'Damage needs evidence', 'multiple-missing-ambiguity': 'Unclear missing item', 'seeded-historical-remedy': 'Existing historical remedy',
  'duplicate-original': 'Original claim', 'duplicate-follow-up': 'Follow-up claim',
  case_identity: 'Correct case and order', expected_outcome: 'Expected outcome', exact_amount: 'Exact amount', item_and_quantity: 'Item and quantity',
  evidence_references: 'Evidence references', policy_stop: 'Policy and holds', human_approval_boundary: 'Human approval required',
  historical_receipt_boundary: 'Historical receipts kept separate', complete_case_coverage: 'Every case checked once', no_payment_attempts: 'No payment attempted',
  no_external_requests: 'No external request', no_new_operations: 'No new refund record', intake_replay: 'Repeated intake reused its case',
  complete_trace_capture: 'Investigation traces complete',
};
const label = value => escape(labels[value] || value);
const money = minor => minor === null ? 'Unknown' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);

export async function evaluateSyntheticPack({ packId, observer = createLocalObserver({ projectName: 'refund-office-local-evaluation' }) } = {}) {
  if (!PACKS.includes(packId)) throw new Error('Choose a committed synthetic demonstration pack.');
  const dataset = validateDemoDataset(JSON.parse(readFileSync(join(ROOT, 'demo-data', `${packId}.json`), 'utf8')));
  const store = createStore({ dbPath: ':memory:', dataset });
  const counters = { externalRequests: 0, paymentAttempts: 0, newOperations: 0, intakeReplays: 0, caseCount: 0 };
  const provider = createProviders({ env: Object.freeze({}), fetchImpl: async () => { counters.externalRequests++; throw new Error('External requests are disabled in this evaluation.'); } });
  const engine = createEngine({ store, provider: { ...provider, createRefund: async () => { counters.paymentAttempts++; throw new Error('Payments are disabled in this evaluation.'); } } });
  const intake = createIntake({ store, engine });
  const observations = [];
  try {
    for (const seed of dataset.cases) {
      await observer.span('refund.intake', { 'span.kind': 'TOOL', synthetic: true, packId, caseId: seed.caseId, action: 'replay' }, async () => {
        const result = intake.submit({ eventId: `demo-${packId}-${seed.id}`, orderId: seed.orderId, complaint: seed.complaint });
        if (result.replayed === true && result.case.id === seed.id) counters.intakeReplays++;
      });
      await observer.span('refund.investigation', { 'span.kind': 'CHAIN', synthetic: true, packId, caseId: seed.caseId, analyser: 'local-rules' }, async traceContext => {
        let item = engine.getCase(seed.id);
        for (let step = 0; ['ready', 'running'].includes(item.status) && step < 8; step++) {
          const stage = item.stage;
          item = await observer.span(`refund.${['reception', 'evidence', 'policy'].includes(stage) ? stage === 'reception' ? 'intake' : stage : 'investigation'}`,
            { 'span.kind': 'TOOL', synthetic: true, packId, caseId: seed.caseId, caseRevision: item.revision, stage, analyser: 'local-rules' },
            () => engine.advanceIntake(seed.id, item.intakeRequestId));
        }
        traceContext?.setAttributes?.({ caseRevision: item.revision, amountMinor: item.proposedAmountMinor, outcome: item.outcome });
        observations.push({ caseRecord: item, traceContext });
      });
    }
    const operations = store.orders().flatMap(order => store.operations(order.id));
    counters.newOperations = operations.filter(operation => !dataset.seedOperations.some(seed => seed.id === operation.id)).length;
    counters.caseCount = store.cases().length;
    await observer.flush();
    const snapshot = observer.snapshot();
    const spans = snapshot.spans;
    const captured = observations.every(item => spans.some(span => span.traceId === item.traceContext?.traceId && span.spanId === item.traceContext?.spanId));
    const status = observer.status();
    const scorecard = buildScorecard({ dataset, observations, counters, traceStatus: { complete: captured && !status.recordingErrors && !status.writeErrors && !snapshot.retention.droppedSpans } });
    return { scorecard, spans, snapshot, recorder: status };
  } finally { store.close(); }
}

export function renderScorecards(scorecards) {
  const cases = scorecards.flatMap(pack => pack.cases.map(item => ({ ...item, packId: pack.dataset.id })));
  const passed = scorecards.every(item => item.passed);
  const rows = cases.map(item => `<tr><td>${escape(item.caseLabel)}<small>${label(item.packId)}</small></td><td>${label(item.category)}</td><td>${label(item.expectedOutcome)}<small>${money(item.expectedAmountMinor)}</small></td><td>${label(item.observedOutcome)}<small>${money(item.observedAmountMinor)}</small></td><td class="${item.passed ? 'pass' : 'fail'}">${item.passed ? 'Passed' : 'Failed'}<details><summary>Checks and trace</summary><ul>${item.evaluations.map(e => `<li><strong>${label(e.name)}: ${escape(e.label)}</strong> — ${escape(e.explanation)}</li>`).join('')}</ul><p>Local trace: <code>${escape(item.traceId || 'Missing')}</code><br>Investigation span: <code>${escape(item.spanId || 'Missing')}</code></p></details></td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refund Office — local evaluation</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#0b1520;color:#eaf2f8;margin:0;padding:clamp(16px,4vw,56px)}main{max-width:1280px;margin:auto}h1{font-size:clamp(28px,4vw,44px);margin:.3em 0}h2{font-size:22px;margin-top:32px}.badge{display:inline-block;border:1px solid #8293a3;padding:6px 12px;border-radius:6px}.pass{color:#72e2ad}.fail{color:#ffacac}.panel{background:#142333;padding:20px;border-radius:10px;margin:20px 0}table{border-collapse:collapse;width:100%;min-width:760px}td,th{text-align:left;vertical-align:top;padding:14px;border-bottom:1px solid #334658}th{background:#1a2a3c}small{display:block;color:#b9c9d6}.table{overflow:auto}td details{max-width:370px;color:#dce7f1;margin-top:8px}details.panel{max-width:none}summary{cursor:pointer}code{font-size:12px;overflow-wrap:anywhere}li{margin:8px 0}a{color:#91c9ff}</style></head><body><main><span class="badge">Synthetic data · local rules · uploads disabled</span><h1>Refund Office evaluation</h1><p>Observed outcomes from fresh investigations, compared with the committed scenario expectations.</p><div class="panel"><h2 class="${passed ? 'pass' : 'fail'}">${passed ? 'All included checks passed' : 'Some checks failed'}</h2><p>${cases.length} cases · ${scorecards.reduce((n, p) => n + p.summary.checks, 0)} checks · no approval or payment requested by the runner</p><p>The runner uses the original application engine in a fresh in-memory store. It does not change your demonstration cases or connect to Arize.</p></div><h2>Run controls</h2>${scorecards.map(pack => `<details class="panel"><summary>${label(pack.dataset.id)}: ${pack.checks.filter(item => item.score === 1).length} of ${pack.checks.length} run controls passed</summary><ul>${pack.checks.map(item => `<li class="${item.score ? 'pass' : 'fail'}">${label(item.name)}: ${escape(item.label)} — ${escape(item.explanation)}</li>`).join('')}</ul></details>`).join('')}<h2>Observed cases</h2><div class="table"><table><thead><tr><th>Case</th><th>Scenario</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div><h2>What this establishes</h2><ul>${scorecards[0]?.limitations.map(item => `<li>${escape(item)}</li>`).join('') || ''}</ul><p><a href="scorecards.json">Scorecards JSON</a> · <a href="traces.json">Local trace records</a></p></main></body></html>`;
}

export async function runEvaluations({ packIds = PACKS, outputBase = join(ROOT, 'work', 'arize-evaluations') } = {}) {
  if (!Array.isArray(packIds) || !packIds.length || new Set(packIds).size !== packIds.length || packIds.some(id => !PACKS.includes(id))) throw new Error('Select each supported pack at most once.');
  const base = resolve(outputBase);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const outputDir = mkdtempSync(join(base, 'run-'));
  const results = [];
  for (const packId of packIds) {
    const observer = createLocalObserver({ filePath: join(outputDir, `${packId}.traces.jsonl`), runId: `evaluation-${packId}`, projectName: 'refund-office-local-evaluation' });
    results.push(await evaluateSyntheticPack({ packId, observer }));
  }
  const scorecards = results.map(item => item.scorecard);
  const save = (name, contents) => writeFileSync(join(outputDir, name), contents, { flag: 'wx', mode: 0o600 });
  save('scorecards.json', JSON.stringify(scorecards, null, 2) + '\n');
  for (const result of results) save(`${result.scorecard.dataset.id}.bundle.json`, JSON.stringify(result.snapshot, null, 2) + '\n');
  save('traces.json', JSON.stringify({ schemaVersion: 1, synthetic: true, uploaded: false, spans: results.flatMap(item => item.spans) }, null, 2) + '\n');
  save('index.html', renderScorecards(scorecards));
  let evaluationRowsPrepared = false;
  try {
    save('arize-evaluations.json', JSON.stringify(prepareArizeEvaluationRows(scorecards, results.flatMap(item => item.spans)), null, 2) + '\n');
    evaluationRowsPrepared = true;
  } catch {
    save('evaluation-preparation.json', JSON.stringify({ prepared: false, uploaded: false, reason: 'Evaluation rows could not be bound to complete recorded investigations. Inspect the local scorecard; no upload was attempted.' }, null, 2) + '\n');
  }
  const passed = evaluationRowsPrepared && scorecards.every(item => item.passed);
  save('manifest.json', JSON.stringify({ schemaVersion: 1, synthetic: true, uploaded: false, packs: scorecards.map(item => item.dataset), recorders: results.map(item => item.recorder), evaluationRowsPrepared, passed }, null, 2) + '\n');
  return { outputDir, passed, cases: scorecards.reduce((n, p) => n + p.summary.cases, 0), checks: scorecards.reduce((n, p) => n + p.summary.checks, 0), spans: results.reduce((n, item) => n + item.spans.length, 0) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => !['--all', ...PACKS].includes(arg))) throw new Error('Choose --all, focused-12 or busy-50.');
    const result = await runEvaluations({ packIds: !args.length || args[0] === '--all' ? PACKS : args });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch { console.error('Local evaluation failed. No provider upload was attempted. Inspect the local preparation and tests.'); process.exitCode = 1; }
}
