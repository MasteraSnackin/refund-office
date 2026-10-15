import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoDataset } from '../scripts/generate-demo-data.mjs';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createProviders } from '../server/providers.mjs';
import { scoreObservedCase, buildScorecard } from '../server/evaluation-scorecard.mjs';

async function fixture() {
  const dataset = buildDemoDataset('focused-12');
  const store = createStore({ dbPath: ':memory:', dataset });
  const engine = createEngine({ store, provider: createProviders({ env: {} }) });
  try {
    const observations = [];
    for (const scenario of dataset.scenarios) {
      let item = engine.getCase(scenario.caseId);
      for (let step = 0; ['ready', 'running'].includes(item.status) && step < 8; step++) item = await engine.advanceIntake(item.id, item.intakeRequestId);
      observations.push({ caseRecord: item, traceContext: { traceId: '1'.repeat(32), spanId: '2'.repeat(16) } });
    }
    return { dataset, observations, counters: { paymentAttempts: 0, externalRequests: 0, newOperations: 0, intakeReplays: 12, caseCount: 12 }, traceStatus: { complete: true } };
  } finally { store.close(); }
}

test('the actual initial investigations satisfy every independent focused-pack expectation', async () => {
  const f = await fixture(), report = buildScorecard(f);
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { cases: 12, passed: 12, failed: 0, checks: 102 });
  assert.equal(report.analyser, 'local-rules');
  assert.equal(report.uploaded, false);
  assert.ok(report.limitations.some(text => text.includes('concurrent workers')));
});

test('wrong amount, unknown citation and a fabricated item are each caught', async () => {
  const f = await fixture(), original = f.observations[0].caseRecord;
  const variants = [
    ['exact_amount', { ...original, proposedAmountMinor: original.proposedAmountMinor + 1 }],
    ['evidence_references', { ...original, proposal: { ...original.proposal, evidenceIds: ['invented-source'] } }],
    ['item_and_quantity', { ...original, proposal: { ...original.proposal, lineId: 'invented-line' } }],
  ];
  for (const [name, caseRecord] of variants) {
    const result = scoreObservedCase({ dataset: f.dataset, scenario: f.dataset.scenarios[0], caseRecord });
    assert.equal(result.passed, false);
    assert.equal(result.evaluations.find(check => check.name === name).score, 0);
  }
});

test('the scorecard rejects an approval, payment-stage entry or unlabelled historical receipt', async () => {
  const f = await fixture();
  for (const mutate of [item => { item.approval.state = 'approved'; }, item => { item.stage = 'payments'; }, item => { item.receipt = { id: 'fictional-payment' }; }]) {
    const altered = structuredClone(f);
    mutate(altered.observations[0].caseRecord);
    assert.equal(buildScorecard(altered).passed, false);
  }
  const historical = structuredClone(f);
  historical.observations[8].caseRecord.receipt.seeded = false;
  assert.equal(buildScorecard(historical).cases[8].passed, false);
});

test('a held case cannot pass by changing its outcome or clearing all failing checks', async () => {
  const f = await fixture();
  const altered = structuredClone(f);
  altered.observations[3].caseRecord.checks.forEach(check => { check.status = 'pass'; });
  assert.equal(buildScorecard(altered).cases[3].evaluations.find(c => c.name === 'policy_stop').score, 0);
  altered.observations[3].caseRecord.outcome = 'awaiting-approval';
  assert.equal(buildScorecard(altered).cases[3].evaluations.find(c => c.name === 'expected_outcome').score, 0);
});

test('missing and duplicated observations cannot produce a complete passing scorecard', async () => {
  const f = await fixture();
  for (const observations of [f.observations.slice(1), [...f.observations, f.observations[0]], f.observations.map((item, i) => i === 1 ? f.observations[0] : item)]) {
    const report = buildScorecard({ ...f, observations });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(item => item.name === 'complete_case_coverage').score, 0);
  }
});

test('missing run counters, a payment attempt or incomplete tracing prevents a complete report', async () => {
  const f = await fixture();
  for (const alteration of [{ counters: {} }, { counters: { ...f.counters, paymentAttempts: 1 } }, { counters: { ...f.counters, externalRequests: 1 } }, { counters: { ...f.counters, newOperations: 1 } }, { traceStatus: { complete: false } }]) {
    assert.equal(buildScorecard({ ...f, ...alteration }).passed, false);
  }
});

test('untrusted complaint, source and error strings do not enter evaluation output', async () => {
  const f = await fixture(), secret = 'Private customer text sk_live_do_not_export';
  for (const item of f.observations) {
    item.caseRecord.complaint = secret;
    item.caseRecord.summary = secret;
    item.caseRecord.proposal.reason = secret;
    item.caseRecord.evidence.forEach(entry => { entry.body = secret; entry.source = secret; });
  }
  f.observations[0].caseRecord.outcome = secret;
  f.observations[0].traceContext.traceId = secret;
  const output = JSON.stringify(buildScorecard(f));
  assert.equal(output.includes(secret), false);
  assert.match(output, /unexpected-or-missing/);
});
