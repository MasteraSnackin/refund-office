import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveIntake, isManagedInvestigation, mergeBootstrap, intakeStatus } from '../src/intake-state.js';

test('queue ownership covers investigation but releases browser payment after approval', () => {
  for (const stage of ['reception', 'evidence', 'policy']) {
    assert.equal(isManagedInvestigation({ intakeManaged: true, stage }), true);
    assert.equal(isManagedInvestigation({ stage }), false);
  }
  for (const stage of ['review', 'payments', 'archive']) assert.equal(isManagedInvestigation({ intakeManaged: true, stage }), false);
});

test('background reads continue only while managed work can advance', () => {
  for (const status of ['ready', 'running']) assert.equal(hasActiveIntake([{ intakeManaged: true, stage: 'evidence', status }]), true);
  for (const status of ['paused', 'error', 'review', 'complete']) assert.equal(hasActiveIntake([{ intakeManaged: true, stage: 'evidence', status }]), false);
  assert.equal(hasActiveIntake([{ intakeManaged: true, stage: 'payments', status: 'running' }]), false);
  assert.equal(hasActiveIntake([{ stage: 'evidence', status: 'running' }]), false);
});

test('a stale poll cannot roll back approval or discard a newly submitted case', () => {
  const approved = { id: 'one', revision: 9, status: 'running', stage: 'payments', approval: { state: 'approved' } };
  const queued = { id: 'two', revision: 0, status: 'ready' };
  const current = { cases: [approved, queued] };
  const incoming = { cases: [{ id: 'one', revision: 8, status: 'review' }], policy: { version: 1 } };
  const merged = mergeBootstrap(current, incoming);
  assert.deepEqual(merged.cases, [queued, approved]);
  assert.deepEqual(mergeBootstrap(null, incoming), incoming);
  const newer = { id: 'one', revision: 10, status: 'complete' };
  assert.equal(mergeBootstrap(current, { cases: [newer] }).cases[1], newer);
});

test('intake statuses distinguish queued work, human review and completed handoff', () => {
  assert.equal(intakeStatus('queued'), 'Queued');
  assert.equal(intakeStatus('running'), 'Investigating');
  assert.equal(intakeStatus('awaiting-review'), 'Awaiting your decision');
  assert.equal(intakeStatus('handoff-complete'), 'Human decision recorded');
});
