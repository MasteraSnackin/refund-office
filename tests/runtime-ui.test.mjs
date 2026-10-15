import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRuntimeCommand, readRuntimeCommand, completeRuntimeCommand, isDefinitiveCommandFailure, runtimePermissions, isRuntimeWorkspace, isReserved, verifyRuntimeDecision } from '../src/runtime-access.js';
import { api } from '../src/api.js';
import { caseStatus, caseBucket, summariseCases, reservationLabels } from '../src/case-view.js';
import { intakeStatus } from '../src/intake-state.js';

const context = { workspaceId: 'synthetic-workspace', profileId: 'reviewer', caseId: 'SYN-C001', action: 'approve' };
const payload = { expectedRevision: 3, expectedAmountMinor: 2000, fingerprint: 'a'.repeat(64), note: 'The packing record supports this exact amount.' };
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('runtime decision is persisted before submission and exact retry retains its identity and facts', () => {
  const state = storage(); let ids = 0;
  const first = prepareRuntimeCommand(state, context, payload, () => { ids++; return '11111111-1111-4111-8111-111111111111'; });
  assert.equal(JSON.parse(state.getItem(first.key)).commandId, first.body.commandId);
  const retry = prepareRuntimeCommand(state, context, { ...payload }, () => { throw new Error('A retry must not create another identity.'); });
  assert.deepEqual(retry.body, first.body); assert.equal(retry.replay, true); assert.equal(ids, 1);
  assert.deepEqual(readRuntimeCommand(state, context).payload, payload);
});

test('unconfirmed decisions block changed amount, revision and note until a definitive result', () => {
  const state = storage(); prepareRuntimeCommand(state, context, payload, () => 'stable-command');
  for (const changed of [{ expectedAmountMinor: 2001 }, { expectedRevision: 4 }, { note: 'A different decision reason.' }]) {
    assert.throws(() => prepareRuntimeCommand(state, context, { ...payload, ...changed }), /still awaiting confirmation/);
  }
  const original = readRuntimeCommand(state, context); completeRuntimeCommand(state, original.key);
  assert.equal(readRuntimeCommand(state, context), null);
  assert.equal(prepareRuntimeCommand(state, context, { ...payload, expectedRevision: 4 }, () => 'new-command').body.commandId, 'new-command');
});

test('retry information is isolated by workspace, profile and case', () => {
  const state = storage(); prepareRuntimeCommand(state, context, payload, () => 'original');
  for (const changed of [{ workspaceId: 'other' }, { profileId: 'investigator' }, { caseId: 'SYN-C002' }]) {
    assert.equal(readRuntimeCommand(state, { ...context, ...changed }), null);
  }
});

test('unavailable storage fails before a consequential request can be prepared', () => {
  assert.throws(() => prepareRuntimeCommand({ getItem() { return null; }, setItem() { throw new Error('blocked'); } }, context, payload, () => 'id'), /could not save/);
  assert.throws(() => prepareRuntimeCommand({ getItem() { return '{'; } }, context, payload), /could not be read/);
});

test('uncertain outcomes and expired sessions preserve the original decision identity', () => {
  for (const error of [{}, { status: 500 }, { status: 401 }, { status: 403 }, { status: 409, uncertain: true }]) assert.equal(isDefinitiveCommandFailure(error), false);
  for (const status of [400, 409, 422]) assert.equal(isDefinitiveCommandFailure({ status }), true);
});

test('runtime roles and queue labels distinguish human review from investigation', () => {
  assert.deepEqual(runtimePermissions({ role: 'reviewer' }), { review: true, investigate: false });
  assert.deepEqual(runtimePermissions({ role: 'investigator' }), { review: false, investigate: true });
  assert.deepEqual(runtimePermissions(null), { review: false, investigate: false });
  assert.equal(isRuntimeWorkspace({ capabilities: { runtime: true } }), true);
  assert.equal(isRuntimeWorkspace({ capabilities: { payments: 'local' } }), false);
  assert.equal(intakeStatus('awaiting-approval'), 'Awaiting reviewer decision');
  assert.equal(intakeStatus('held'), 'Review needed');
});

test('a PostgreSQL reservation remains open, unpaid and excluded from refund totals', () => {
  const item = { id: 'SYN-C001', status: 'reserved', outcome: 'approved-not-submitted', proposedAmountMinor: 2000, approval: { state: 'approved', amountMinor: 2000 }, operationId: 'reserved-example', receipt: null };
  assert.equal(isReserved(item), true);
  assert.equal(caseStatus(item).label, 'Approved — not submitted');
  assert.equal(caseBucket(item), 'open');
  const totals = summariseCases([item]);
  assert.equal(totals.open, 1); assert.equal(totals.resolved, 0); assert.equal(totals.recordedMinor, 0); assert.equal(totals.recordedCount, 0);
});

test('hosted case reservation labels cannot claim the separate payment is unsubmitted', () => {
  const item = { status: 'reserved', outcome: 'approved-not-submitted' };
  const hosted = { hosted: true, separateTestExecutionConfigured: true };
  assert.equal(caseStatus(item, hosted).label, 'Original approval saved');
  const labels = reservationLabels(hosted);
  assert.equal(labels.activity, 'Separate execution record');
  assert.equal(labels.panelTitle, 'Original approval and reservation');
  assert.doesNotMatch(Object.values(labels).join(' '), /not submitted|no payment was submitted|disabled|Reserved only/i);
  for (const capability of [undefined, { hosted: false, separateTestExecutionConfigured: true }, { hosted: true, separateTestExecutionConfigured: false }]) {
    assert.equal(caseStatus(item, capability).label, 'Approved — not submitted');
    assert.equal(reservationLabels(capability).activity, 'Payment submission disabled');
  }
});

test('a decision response must match the case, amount, approval facts and disabled payment boundary', () => {
  const saved = { id: context.caseId, revision: 4, outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000, fingerprint: payload.fingerprint }, operationId: 'reserved-local', receipt: null, paymentSubmissionEnabled: false };
  assert.equal(verifyRuntimeDecision(saved, context.caseId, { approval: payload }), saved);
  for (const change of [{ id: 'other' }, { revision: null }, { outcome: 'refunded' }, { receipt: { id: 'unexpected' } }, { paymentSubmissionEnabled: true }, { approval: { ...saved.approval, amountMinor: 2001 } }]) {
    assert.throws(() => verifyRuntimeDecision({ ...saved, ...change }, context.caseId, { approval: payload }), error => error.uncertain === true);
  }
});

test('an unreadable successful HTTP response remains uncertain and cannot clear a saved command', async () => {
  const original = globalThis.fetch;
  try {
    for (const body of ['{broken', 'null', '[]']) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      await assert.rejects(api('/cases/example/approve', { method: 'POST', body: payload }), error => error.uncertain === true && error.code === 'unverified_response' && !isDefinitiveCommandFailure(error));
    }
  } finally { globalThis.fetch = original; }
});

test('session rejection notifies the office boundary and uses same-origin cookies', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  const target = new EventTarget(); let events = 0;
  target.addEventListener('refund-office:session-expired', () => events++);
  globalThis.window = target;
  try {
    globalThis.fetch = async (_, options) => { assert.equal(options.credentials, 'same-origin'); return Response.json({ error: { code: 'runtime_session_required', message: 'Session ended.' } }, { status: 401 }); };
    await assert.rejects(api('/bootstrap'), error => error.status === 401);
    assert.equal(events, 1);
    await assert.rejects(api('/session'), error => error.status === 401);
    assert.equal(events, 1, 'The public session endpoint must not recursively emit expiry events.');
  } finally { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});
