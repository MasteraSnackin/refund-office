import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, evaluateCase, getFrames } from '../src/workflow.js';

test('a supported missing item permits exactly one £20 demo remedy', () => {
  const result = evaluateCase('missing-item');
  assert.equal(result.outcome, 'refunded');
  assert.equal(result.amount, 20);
  const frames = getFrames('missing-item');
  assert.deepEqual(frames.map(({ station }) => station), ['reception', 'evidence', 'policy', 'payments', 'archive']);
  assert.match(frames.at(-1).detail, /No real money moved/);
});

test('conflicting evidence stops at review without entering payments', () => {
  assert.equal(evaluateCase('conflicting-evidence').amount, 0);
  assert.equal(evaluateCase('conflicting-evidence').outcome, 'held');
  const frames = getFrames('conflicting-evidence');
  assert.ok(!frames.some(({ station }) => station === 'payments'));
  assert.equal(frames.at(-1).station, 'review');
  assert.match(frames.at(-1).detail, /Request delivery evidence/);
});

test('both a seeded repeat request and a replay produce zero additional refund', () => {
  for (const [id, resolved] of [['repeat-request', false], ['missing-item', true]]) {
    const result = evaluateCase(id, resolved);
    assert.equal(result.outcome, 'already-resolved');
    assert.equal(result.amount, 0);
    const frames = getFrames(id, resolved);
    assert.ok(!frames.some(({ station }) => station === 'payments'));
    assert.equal(frames.at(-1).stage, 2);
    assert.equal(frames.at(-1).station, 'archive');
  }
});

test('every path has one matching terminal result and non-negative timings', () => {
  assert.equal(SCENARIOS.length, 3);
  assert.equal(new Set(SCENARIOS.map(({ id }) => id)).size, 3);
  for (const scenario of SCENARIOS) {
    for (const resolved of [false, true]) {
      const frames = getFrames(scenario.id, resolved);
      assert.equal(frames.filter(({ terminal }) => terminal).length, 1);
      assert.equal(frames.at(-1).terminal, true);
      assert.equal(frames.at(-1).duration, 0);
      assert.equal(frames.at(-1).outcome, evaluateCase(scenario.id, resolved).outcome);
      assert.ok(frames.every(({ stage, duration }) => stage >= 0 && stage <= 4 && duration >= 0));
      assert.ok(frames.every((item, index) => !index || item.stage >= frames[index - 1].stage));
    }
  }
});

test('unknown scenarios fail closed instead of granting a default refund', () => {
  assert.throws(() => evaluateCase('unknown'), RangeError);
  assert.throws(() => getFrames('unknown'), RangeError);
});
