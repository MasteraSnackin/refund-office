import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPostgresRuntime, sqlLiteral } from '../server/local-postgres-runtime.mjs';

const tenantId = '00000000-0000-4000-8000-000000000012';
const reviewer = { userId: '40000000-0000-4000-8000-000000000001', role: 'reviewer' };
const investigator = { userId: '40000000-0000-4000-8000-000000000002', role: 'investigator' };
const commandId = '50000000-0000-4000-8000-000000000001';
const fingerprint = 'a'.repeat(64);
const item = { id: 'case-1', orderId: 'order-1', complaint: 'The travel mug is missing.', revision: 4, intakeRequestId: 'request-1', approval: null, operationId: null, receipt: null };
const proposal = { amountMinor: 2000, lineId: 'line-1', issue: 'item_missing', reason: 'One travel mug was omitted.', evidenceIds: ['packing:order-1'], source: 'local' };
function repository(profile, replies = []) {
  const calls = [];
  const api = createLocalPostgresRuntime({ tenantId, profile, executeSql: async input => {
    calls.push(input); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply;
  } });
  return { api, calls };
}

test('local profile identity is captured and role separation prevents unauthorised calls before SQL', async () => {
  const profile = { ...investigator };
  const { api, calls } = repository(profile, [item]); profile.role = 'reviewer'; profile.userId = reviewer.userId;
  await assert.rejects(api.approveAndReserve({}), error => error.code === 'runtime_access_denied');
  await api.readCase(item.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].userId, investigator.userId); assert.equal(calls[0].role, 'authenticated');
  assert.equal(api.capabilities().networkMode, 'offline'); assert.equal(api.capabilities().paymentSubmission, false);
  const human = repository(reviewer);
  await assert.rejects(human.api.claimIntake(), error => error.code === 'runtime_access_denied');
  assert.equal(human.calls.length, 0);
});

test('SQL literals retain apostrophes and metacharacters as data; null bytes and invalid identities fail', async () => {
  assert.equal(sqlLiteral("a'; SELECT dangerous(); --\\"), "'a''; SELECT dangerous(); --\\'");
  assert.throws(() => sqlLiteral('bad\u0000value'));
  assert.throws(() => createLocalPostgresRuntime({ tenantId: 'bad', profile: reviewer, executeSql() {} }));
  const { api, calls } = repository(reviewer);
  await assert.rejects(api.readCase("case');DROP TABLE cases;--"));
  assert.equal(calls.length, 0);
});

test('intake supports existing event syntax and binds the acknowledgement and independent readback', async () => {
  const request = { id: 'request-1', eventId: 'mail:order.1', caseId: item.id, orderId: item.orderId };
  const { api, calls } = repository(investigator, [{ request, case: item, replayed: false }, item]);
  const result = await api.enqueueIntake({ eventId: request.eventId, orderId: item.orderId, complaint: item.complaint });
  assert.equal(result.readbackVerified, true); assert.equal(calls.length, 2);
  assert.match(calls[0].statement, /p_event_id => 'mail:order\.1'::text/);
  assert.match(calls[1].statement, /refund_runtime_read_case/);
  const mismatch = repository(investigator, [{ request: { ...request, eventId: 'other' }, case: item, replayed: false }]);
  await assert.rejects(mismatch.api.enqueueIntake({ eventId: request.eventId, orderId: item.orderId, complaint: item.complaint }), error => error.uncertain === true);
});

test('claim and finish stay before approval, retain the exact request and read back the saved case', async () => {
  const request = { id: 'request-1', caseId: item.id };
  const claim = { requestId: request.id, caseId: item.id, fence: 1, leaseUntil: '2026-10-15T00:00:00.000Z', case: item, order: { id: item.orderId }, evidence: [], policy: { limitMinor: 2500 } };
  const { api } = repository(investigator, [claim, { request, case: item }, item]);
  assert.deepEqual(await api.claimIntake(), claim);
  assert.equal((await api.finishIntake({ requestId: request.id, fence: 1, proposal })).readbackVerified, true);
  const bad = repository(investigator, [{ ...claim, case: { ...item, approval: { state: 'approved' } } }]);
  await assert.rejects(bad.api.claimIntake(), error => error.uncertain);
  await assert.rejects(api.finishIntake({ requestId: request.id, fence: 1, proposal: { ...proposal, source: 'openai' } }), error => error.code === 'invalid_runtime_input');
});

test('approval requires exact saved amount/fingerprint and returns only a disabled reservation', async () => {
  const approved = { ...item, revision: 5, operationId: 'operation-1', outcome: 'approved-not-submitted', approval: { state: 'approved', amountMinor: 2000, fingerprint } };
  const operation = { id: 'operation-1', status: 'reserved', submissionEnabled: false, amountMinor: 2000 };
  const { api, calls } = repository(reviewer, [{ case: approved, operation, replayed: false }, approved]);
  const input = { caseId: item.id, expectedRevision: 4, expectedFingerprint: fingerprint, expectedAmountMinor: 2000, note: "I checked the order's exact missing item.", commandId };
  assert.equal((await api.approveAndReserve(input)).readbackVerified, true);
  assert.match(calls[0].statement, /order''s/);
  assert.equal('submit' in api, false); assert.equal('createRefund' in api, false);
  const bad = repository(reviewer, [{ case: approved, operation: { ...operation, submissionEnabled: true }, replayed: false }]);
  await assert.rejects(bad.api.approveAndReserve(input), error => error.uncertain);
});

test('malformed review acknowledgements and lost writes remain uncertain, without automatic retries', async () => {
  const input = { caseId: item.id, expectedRevision: 4, action: 'close-no-refund', note: 'The current evidence cannot establish this refund.', commandId };
  const malformed = repository(reviewer, [{ id: 'wrong', revision: -1 }]);
  await assert.rejects(malformed.api.reviewCase(input), error => error.uncertain === true);
  assert.equal(malformed.calls.length, 1);
  const lost = repository(reviewer, [new Error('transport')]);
  await assert.rejects(lost.api.reviewCase(input), error => error.code === 'runtime_transport_unresolved' && error.uncertain);
  assert.equal(lost.calls.length, 1);
  const rejected = repository(reviewer, [Object.assign(new Error('private provider detail'), { sqlState: '40001' })]);
  await assert.rejects(rejected.api.reviewCase(input), error => error.code === 'runtime_conflict' && !error.uncertain && !error.message.includes('private'));
});

test('failure and recovery use exact bounded codes, fencing and stable recovery commands', async () => {
  const request = { id: 'request-1', caseId: item.id };
  const { api, calls } = repository(investigator, [{ request, case: item }, item, { request, case: item, replayed: false }, item]);
  for (const code of ['1bad','bad-code','bad code','Acode']) await assert.rejects(api.failIntake({ requestId: request.id, fence: 1, errorCode: code }), error => error.code === 'invalid_runtime_input');
  assert.equal(calls.length, 0);
  await api.failIntake({ requestId: request.id, fence: 1, errorCode: 'analysis_failed' });
  await api.recoverIntake({ requestId: request.id, expectedRevision: 4, note: 'Retry after the local analyser failure was inspected.', commandId });
  assert.match(calls[0].statement, /p_fence => 1::bigint/);
  assert.match(calls[2].statement, /p_command_id => '50000000-0000-4000-8000-000000000001'::uuid/);
});
