import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateSyntheticPack, runEvaluations, renderScorecards } from '../scripts/evaluate-arize.mjs';
import { createLocalObserver } from '../server/observability.mjs';
import { prepareArizeEvaluationRows } from '../server/arize-evaluations.mjs';

for (const packId of ['focused-12', 'busy-50']) test(`${packId} evaluation measures actual local operations and binds every score to its recorded span`, async () => {
  const result = await evaluateSyntheticPack({ packId });
  assert.equal(result.scorecard.passed, true);
  assert.equal(result.scorecard.cases.length, packId === 'focused-12' ? 12 : 50);
  assert.ok(result.spans.length > result.scorecard.cases.length);
  assert.ok(result.spans.every(span => span.kind !== 'LLM'));
  const annotations = prepareArizeEvaluationRows([result.scorecard], result.spans);
  assert.equal(annotations.rows.length, result.scorecard.cases.length);
  assert.ok(annotations.rows.every(row => Object.keys(row).length === 25));
  assert.equal(annotations.uploaded, false);
});

test('prepared evaluation rows reject missing, wrong-case or duplicate trace bindings', async () => {
  const result = await evaluateSyntheticPack({ packId: 'focused-12' });
  assert.throws(() => prepareArizeEvaluationRows([result.scorecard], []));
  const bad = structuredClone(result.spans);
  bad.find(span => span.spanId === result.scorecard.cases[0].spanId).attributes.caseId = 'RF-999';
  assert.throws(() => prepareArizeEvaluationRows([result.scorecard], bad));
  assert.throws(() => prepareArizeEvaluationRows([result.scorecard], [...result.spans, result.spans[0]]));
});

test('trace loss prevents claiming that an evaluation capture is complete', async () => {
  const observer = createLocalObserver({ maxSpans: 2 });
  const result = await evaluateSyntheticPack({ packId: 'focused-12', observer });
  assert.equal(result.scorecard.passed, false);
  assert.equal(result.scorecard.checks.find(check => check.name === 'complete_trace_capture').score, 0);
  assert.throws(() => prepareArizeEvaluationRows([result.scorecard], result.spans));
});

test('altered explanations or observed facts cannot be prepared as Arize evaluation rows', async () => {
  const result = await evaluateSyntheticPack({ packId: 'focused-12' });
  for (const mutate of [item => { item.revision++; }, item => { item.observedAmountMinor++; }, item => { item.observedOutcome = 'held'; }, item => { item.evaluations[0].explanation = 'Private customer statement'; }]) {
    const report = structuredClone(result.scorecard);
    mutate(report.cases[0]);
    assert.throws(() => prepareArizeEvaluationRows([report], result.spans));
  }
});

test('each evaluation run writes a new local output folder and a safe viewable report', async t => {
  const base = mkdtempSync(join(tmpdir(), 'refund-evaluation-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const first = await runEvaluations({ packIds: ['focused-12'], outputBase: base });
  const second = await runEvaluations({ packIds: ['focused-12'], outputBase: base });
  assert.equal(first.passed, true);
  assert.notEqual(first.outputDir, second.outputDir);
  const scorecards = JSON.parse(readFileSync(join(first.outputDir, 'scorecards.json')));
  assert.equal(scorecards[0].uploaded, false);
  const bundle = JSON.parse(readFileSync(join(first.outputDir, 'focused-12.bundle.json')));
  assert.equal(bundle.format, 'refund-office-local-traces');
  const html = readFileSync(join(first.outputDir, 'index.html'), 'utf8');
  assert.match(html, /uploads disabled/);
  assert.doesNotMatch(html, /<script|https?:\/\//);
  scorecards[0].cases[0].category = '<img src=x onerror=alert(1)>';
  assert.ok(renderScorecards(scorecards).includes('&lt;img'));
});
