import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseRuntimeRepository } from '../server/supabase-runtime-repository.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const fingerprint = 'a'.repeat(64);
const fakeToken = (extra = {}) => `test.${Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300, ...extra })).toString('base64url')}.not-a-real-signature`;
const environment = () => ({ REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime', SUPABASE_URL: 'https://offline-fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_fixture' });
const savedCase = (extra = {}) => ({ id: 'SYN-F12-C001', revision: 3, orderId: 'SYN-F12-O001', complaint: 'One travel mug is missing.', ...extra });
const savedRequest = (extra = {}) => ({ id: 'request-1', eventId: 'form-1', caseId: 'SYN-F12-C001', orderId: 'SYN-F12-O001', ...extra });
const approvedCase = () => savedCase({ revision: 4, operationId: 'op-reserved', approval: { state: 'approved', amountMinor: 2000, fingerprint }, outcome: 'approved-not-submitted' });
const approvalInput = () => ({ caseId: 'SYN-F12-C001', expectedRevision: 3, expectedFingerprint: fingerprint, expectedAmountMinor: 2000, note: 'I reviewed the missing-item evidence.', commandId });
const reservation = () => ({ case: approvedCase(), operation: { id: 'op-reserved', status: 'reserved', amountMinor: 2000, submissionEnabled: false }, replayed: false });
function harness(responses, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    assert.notEqual(next, undefined, 'An unexpected network request was attempted');
    return Response.json(next);
  };
  return { calls, repository: createSupabaseRuntimeRepository({ env: environment(), tenantId, getAccessToken: async () => fakeToken(), fetchImpl, ...options }) };
}

test('runtime stays disconnected before reading credentials, session or transport', async () => {
  const env = new Proxy({}, { get(_target, name) { assert.equal(name, 'REFUND_OFFICE_NETWORK'); return 'offline'; } });
  const repository = createSupabaseRuntimeRepository({ env, getAccessToken() { assert.fail('Session read while offline'); }, fetchImpl() { assert.fail('Network while offline'); } });
  for (const action of [() => repository.readWorkspace(), () => repository.readCase('anything'), () => repository.enqueueIntake(), () => repository.claimIntake(), () => repository.finishIntake(), () => repository.approveAndReserve(), () => repository.reviewCase(), () => repository.recoverIntake(), () => repository.failIntake()]) {
    await assert.rejects(action, { code: 'runtime_disconnected', uncertain: false });
  }
  assert.equal(repository.capabilities().paymentSubmission, false);
  assert.equal(repository.capabilities().selectedByLocalApp, false);
  assert.equal(repository.submitPayment, undefined);
  assert.equal(repository.settlePayment, undefined);
});

test('each opt-in is required and the archive adapter permission does not enable working storage', async () => {
  for (const change of [{ REFUND_OFFICE_NETWORK: 'offline' }, { REFUND_OFFICE_WORKING_STORE: 'sqlite' }, { REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase' }]) {
    const { repository, calls } = harness([], { env: { ...environment(), ...change } });
    await assert.rejects(() => repository.readWorkspace(), { code: 'runtime_disconnected' });
    assert.equal(calls.length, 0);
  }
});

test('invalid endpoints and privileged keys are rejected before transport', async () => {
  for (const change of [
    { SUPABASE_URL: 'http://localhost:54321' }, { SUPABASE_URL: 'https://offline-fixture.supabase.co.attacker.example' },
    { SUPABASE_URL: 'https://offline-fixture.supabase.co/rest/v1' }, { SUPABASE_URL: 'https://user:secret@offline-fixture.supabase.co/' },
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture' }, { SUPABASE_PUBLISHABLE_KEY: fakeToken({ role: 'service_role' }) },
  ]) {
    const { repository, calls } = harness([], { env: { ...environment(), ...change } });
    await assert.rejects(() => repository.readWorkspace(), { code: 'runtime_configuration_required' });
    assert.equal(calls.length, 0);
  }
});

test('missing, expired, anonymous and privileged user sessions cannot call the runtime', async () => {
  for (const token of [undefined, 'broken', fakeToken({ exp: 1 }), fakeToken({ is_anonymous: true }), fakeToken({ role: 'service_role' }), fakeToken({ sub: 'local-reviewer' })]) {
    const { repository, calls } = harness([], { getAccessToken: async () => token });
    await assert.rejects(() => repository.readWorkspace(), { code: 'reviewer_session_required' });
    assert.equal(calls.length, 0);
  }
});

test('reads bind tenant and require a synthetic workspace with payment execution disabled', async () => {
  const workspace = { tenantId, mode: 'synthetic-only', paymentsEnabled: false, orders: [], cases: [], intakeRequests: [], policy: {} };
  const { repository, calls } = harness([workspace, { ...workspace, paymentsEnabled: true }]);
  assert.deepEqual(await repository.readWorkspace(), workspace);
  assert.deepEqual(calls[0].body, { p_tenant_id: tenantId });
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/refund_runtime_read_workspace$/);
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(() => repository.readWorkspace(), { code: 'unverified_runtime_response' });
});

test('intake acknowledges success only after independently reading the saved case', async () => {
  const record = savedCase();
  const { repository, calls } = harness([{ case: record, request: savedRequest(), replayed: false }, record]);
  const result = await repository.enqueueIntake({ eventId: 'form-1', orderId: record.orderId, complaint: record.complaint });
  assert.equal(result.readbackVerified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.p_event_id, 'form-1');
  assert.equal(calls[1].body.p_case_id, record.id);
  assert.equal(calls[0].body.p_tenant_id, tenantId);
  assert.equal('p_actor' in calls[0].body, false);
});

test('intake with changed readback is unresolved rather than successful', async () => {
  const record = savedCase();
  const { repository } = harness([{ case: record, request: savedRequest(), replayed: true }, { ...record, complaint: 'Different contents' }]);
  await assert.rejects(() => repository.enqueueIntake({ eventId: 'form-1', orderId: record.orderId, complaint: record.complaint }), { code: 'unverified_runtime_response', uncertain: true });
});

test('claims retain durable lease and fencing identity, and do not expose a payment action', async () => {
  const claim = { requestId: 'request-1', caseId: 'SYN-F12-C001', fence: 2, leaseUntil: new Date(Date.now() + 30000).toISOString(), case: savedCase(), order: {}, evidence: [], policy: {} };
  const { repository, calls } = harness([claim, null]);
  assert.deepEqual(await repository.claimIntake(), claim);
  assert.equal(await repository.claimIntake(), null);
  assert.equal(calls[0].body.p_lease_seconds, 30);
  await assert.rejects(() => repository.claimIntake({ leaseSeconds: 1000 }), { code: 'invalid_runtime_input' });
  assert.equal(calls.length, 2);
});

test('finishing an investigation verifies saved state and never treats an approval as its own work', async () => {
  const record = savedCase({ approval: { state: 'required' }, outcome: 'awaiting-approval' });
  const { repository, calls } = harness([{ request: savedRequest(), case: record }, record]);
  const proposal = { amountMinor: 2000, source: 'local', issue: 'missing_item', lineId: 'mug', reason: 'Packing record', evidenceIds: ['packing'] };
  assert.equal((await repository.finishIntake({ requestId: 'request-1', fence: 2, proposal })).readbackVerified, true);
  assert.equal(calls[0].body.p_fence, 2);
  const bad = harness([{ request: {}, case: approvedCase() }]);
  await assert.rejects(() => bad.repository.finishIntake({ requestId: 'request-1', fence: 2, proposal }), { code: 'unverified_runtime_response', uncertain: true });
});

test('intake accepts existing punctuation rules and rejects an unrelated saved request', async () => {
  const record = savedCase(), eventId = 'source:form.1';
  const { repository, calls } = harness([{ case: record, request: savedRequest({ eventId }), replayed: false }, record]);
  assert.equal((await repository.enqueueIntake({ eventId, orderId: record.orderId, complaint: record.complaint })).readbackVerified, true);
  assert.equal(calls[0].body.p_event_id, eventId);
  const unrelated = harness([{ case: record, request: savedRequest({ eventId: 'different-event' }), replayed: true }]);
  await assert.rejects(() => unrelated.repository.enqueueIntake({ eventId, orderId: record.orderId, complaint: record.complaint }), { uncertain: true });
  const wrongFinish = harness([{ case: record, request: savedRequest({ id: 'different-request' }) }]);
  await assert.rejects(() => wrongFinish.repository.finishIntake({ requestId: 'request-1', fence: 1, proposal: { source: 'local' } }), { uncertain: true });
});

test('approval preserves the command identity and exact amount and verifies a disabled reservation', async () => {
  const { repository, calls } = harness([reservation(), approvedCase()]);
  const result = await repository.approveAndReserve(approvalInput());
  assert.equal(result.readbackVerified, true);
  assert.equal(result.operation.status, 'reserved');
  assert.equal(result.operation.submissionEnabled, false);
  assert.equal(calls[0].body.p_command_id, commandId);
  assert.equal(calls[0].body.p_expected_amount_minor, 2000);
  assert.equal(calls[0].body.p_expected_fingerprint, fingerprint);
  assert.equal(calls[0].body.p_expected_revision, 3);
  assert.equal(calls.length, 2);
});

test('changed amount, payment state or approval fingerprint cannot be reported as confirmed', async () => {
  for (const [ack, readback] of [
    [{ ...reservation(), operation: { ...reservation().operation, amountMinor: 2100 } }, approvedCase()],
    [{ ...reservation(), operation: { ...reservation().operation, submissionEnabled: true } }, approvedCase()],
    [{ ...reservation(), operation: { ...reservation().operation, status: 'succeeded' } }, approvedCase()],
    [reservation(), { ...approvedCase(), approval: { ...approvedCase().approval, fingerprint: 'b'.repeat(64) } }],
    [reservation(), { ...approvedCase(), operationId: 'different-operation' }],
  ]) {
    const { repository } = harness([ack, readback]);
    await assert.rejects(() => repository.approveAndReserve(approvalInput()), { code: 'unverified_runtime_response', uncertain: true });
  }
});

test('lost mutation response is unresolved and is never automatically retried', async () => {
  const { repository, calls } = harness([new Error('Sensitive provider text')]);
  await assert.rejects(() => repository.approveAndReserve(approvalInput()), error => {
    assert.equal(error.code, 'runtime_transport_unresolved');
    assert.equal(error.uncertain, true);
    assert.doesNotMatch(error.message, /Sensitive/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('failed post-write verification remains unresolved', async () => {
  const { repository, calls } = harness([reservation(), new Error('read failed')]);
  await assert.rejects(() => repository.approveAndReserve(approvalInput()), { code: 'unverified_runtime_response', uncertain: true });
  assert.equal(calls.length, 2);
});

test('database rejections are explicit and do not repeat the write or leak server details', async () => {
  for (const [code, expected] of [['42501', 'runtime_access_denied'], ['40001', 'runtime_conflict'], ['23505', 'runtime_conflict']]) {
    const { repository, calls } = harness([() => Response.json({ code, message: 'private database details' }, { status: 400 })]);
    await assert.rejects(() => repository.approveAndReserve(approvalInput()), error => {
      assert.equal(error.code, expected); assert.equal(error.uncertain, false); assert.doesNotMatch(error.message, /private/); return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('unknown errors and malformed or oversized write responses remain unresolved', async () => {
  for (const response of [
    () => new Response('not JSON', { status: 502 }),
    () => Response.json({ message: 'secret' }, { status: 503 }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const { repository, calls } = harness([response]);
    await assert.rejects(() => repository.approveAndReserve(approvalInput()), error => error.uncertain === true && !error.message.includes('secret'));
    assert.equal(calls.length, 1);
  }
});

test('a bounded timeout reports an unknown write result and does not retry', async () => {
  const { repository, calls } = harness([(_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))], { timeoutMs: 5 });
  await assert.rejects(() => repository.approveAndReserve(approvalInput()), { code: 'runtime_transport_unresolved', uncertain: true });
  assert.equal(calls.length, 1);
});

test('approval requires an explicit stable identity and bounded input before transport', async () => {
  const { repository, calls } = harness([]);
  for (const change of [{ commandId: undefined }, { expectedRevision: -1 }, { expectedAmountMinor: 0 }, { note: 'yes' }, { expectedFingerprint: 'not-a-fingerprint' }]) {
    await assert.rejects(() => repository.approveAndReserve({ ...approvalInput(), ...change }), { code: 'invalid_runtime_input' });
  }
  assert.equal(calls.length, 0);
});

const decisionNote = 'I inspected the saved evidence and current state.';
const reviewInput = (action = 'request-evidence') => ({ caseId: savedCase().id, expectedRevision: 3, action, note: decisionNote, commandId });
const reviewResult = (action = 'request-evidence') => savedCase({ revision: 4, review: { action, note: decisionNote, actor: userId }, approval: null, receipt: null, operationId: null });
const recoveryInput = () => ({ requestId: 'request-1', expectedRevision: 3, note: decisionNote, commandId });
const recoveryResult = () => ({ request: savedRequest({ status: 'queued', fence: 3 }), case: savedCase({ revision: 4, intakeRequestId: 'request-1', status: 'ready', stage: 'reception' }), replayed: false });
const failureInput = () => ({ requestId: 'request-1', fence: 2, errorCode: 'investigation_failed' });
const failureResult = () => ({ request: savedRequest({ status: 'error', fence: 2, lastError: 'investigation_failed' }), case: savedCase({ revision: 4, intakeRequestId: 'request-1', status: 'paused', stage: 'review', outcome: 'held' }) });

test('all stage-002 actions remain disconnected until every explicit runtime gate is enabled', async () => {
  for (const change of [{ REFUND_OFFICE_NETWORK: 'offline' }, { REFUND_OFFICE_WORKING_STORE: 'sqlite' }, { REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase' }]) {
    const { repository, calls } = harness([], { env: { ...environment(), ...change }, getAccessToken() { assert.fail('Session read while disconnected'); } });
    for (const [method, input] of [['reviewCase', reviewInput()], ['recoverIntake', recoveryInput()], ['failIntake', failureInput()]]) {
      await assert.rejects(() => repository[method](input), { code: 'runtime_disconnected', uncertain: false });
    }
    assert.equal(calls.length, 0);
  }
});

test('review decisions retain their exact actor-independent command and verify each saved action', async () => {
  for (const action of ['request-evidence', 'close-no-refund', 'reopen']) {
    const saved = reviewResult(action), { repository, calls } = harness([saved, saved]);
    assert.deepEqual(await repository.reviewCase(reviewInput(action)), saved);
    assert.match(calls[0].url, /\/refund_runtime_review_case$/);
    assert.deepEqual(calls[0].body, { p_tenant_id: tenantId, p_case_id: saved.id, p_expected_revision: 3, p_action: action, p_note: decisionNote, p_command_id: commandId });
    assert.match(calls[1].url, /\/refund_runtime_read_case$/);
    assert.equal(calls.length, 2);
  }
});

test('recovery retains the stable command and may observe a later investigation after the queue write', async () => {
  const ack = recoveryResult(), later = { ...ack.case, revision: 6, status: 'paused', stage: 'review', outcome: 'awaiting-approval' };
  const { repository, calls } = harness([{ ...ack, replayed: true }, later]);
  const result = await repository.recoverIntake(recoveryInput());
  assert.equal(result.replayed, true); assert.equal(result.readbackVerified, true); assert.deepEqual(result.case, later);
  assert.match(calls[0].url, /\/refund_runtime_recover_intake$/);
  assert.deepEqual(calls[0].body, { p_tenant_id: tenantId, p_request_id: 'request-1', p_expected_revision: 3, p_note: decisionNote, p_command_id: commandId });
  assert.equal(calls[1].body.p_case_id, later.id);
});

test('failure reporting binds the exact owned fence and bounded code before independent readback', async () => {
  const ack = failureResult(), { repository, calls } = harness([ack, ack.case]);
  const result = await repository.failIntake(failureInput());
  assert.equal(result.readbackVerified, true); assert.equal(result.request.status, 'error');
  assert.match(calls[0].url, /\/refund_runtime_fail_intake$/);
  assert.deepEqual(calls[0].body, { p_tenant_id: tenantId, p_request_id: 'request-1', p_fence: 2, p_error_code: 'investigation_failed' });
  assert.equal(calls.length, 2);
});

test('review rejects unrelated, malformed or payment-bearing acknowledgements as unresolved writes', async () => {
  for (const ack of [null, {}, { ...reviewResult(), id: 'different-case' }, { ...reviewResult(), revision: 3 },
    { ...reviewResult(), review: { action: 'reopen', note: decisionNote } }, { ...reviewResult(), review: { action: 'request-evidence', note: 'Changed reason' } },
    { ...reviewResult(), operationId: 'op-reserved' }, { ...reviewResult(), approval: { state: 'approved' } }]) {
    const { repository, calls } = harness([ack]);
    await assert.rejects(() => repository.reviewCase(reviewInput()), { code: 'unverified_runtime_response', uncertain: true });
    assert.equal(calls.length, 1);
  }
});

test('recovery and failure never confirm another request, claim fence or payment state', async () => {
  for (const [method, input, makeResult] of [['recoverIntake', recoveryInput(), recoveryResult], ['failIntake', failureInput(), failureResult]]) {
    const good = makeResult();
    for (const ack of [
      { ...good, request: { ...good.request, id: 'different-request' } },
      { ...good, request: { ...good.request, caseId: 'different-case' } },
      { ...good, case: { ...good.case, intakeRequestId: 'different-request' } },
      { ...good, case: { ...good.case, receipt: { id: 'unrelated' } } },
      method === 'failIntake' ? { ...good, request: { ...good.request, fence: 9 } } : { ...good, replayed: undefined },
      method === 'failIntake' ? { ...good, request: { ...good.request, lastError: 'different_error' } } : { ...good, case: { ...good.case, status: 'paused' } },
    ]) {
      const { repository, calls } = harness([ack]);
      await assert.rejects(() => repository[method](input), { code: 'unverified_runtime_response', uncertain: true });
      assert.equal(calls.length, 1);
    }
  }
});

test('stage-002 verification failures stay unresolved without retrying or issuing another mutation', async () => {
  for (const [method, input, ack] of [['reviewCase', reviewInput(), reviewResult()], ['recoverIntake', recoveryInput(), recoveryResult()], ['failIntake', failureInput(), failureResult()]]) {
    const item = ack.case || ack;
    for (const readback of [new Error('private transport details'), { ...item, revision: item.revision - 1 }, { ...item, id: 'different-case' }]) {
      const { repository, calls } = harness([ack, readback]);
      await assert.rejects(() => repository[method](input), { code: 'unverified_runtime_response', uncertain: true });
      assert.equal(calls.length, 2); assert.match(calls[1].url, /\/refund_runtime_read_case$/);
    }
    const { repository, calls } = harness([new Error('private transport details')]);
    await assert.rejects(() => repository[method](input), error => error.code === 'runtime_transport_unresolved' && error.uncertain && !error.message.includes('private'));
    assert.equal(calls.length, 1);
  }
});

test('stage-002 role and revision rejections are definitive and do not leak database details', async () => {
  for (const [method, input] of [['reviewCase', reviewInput()], ['recoverIntake', recoveryInput()], ['failIntake', failureInput()]]) {
    for (const [code, expected] of [['42501', 'runtime_access_denied'], ['40001', 'runtime_conflict']]) {
      const { repository, calls } = harness([() => Response.json({ code, message: 'private database details' }, { status: 400 })]);
      await assert.rejects(() => repository[method](input), error => error.code === expected && !error.uncertain && !error.message.includes('private'));
      assert.equal(calls.length, 1);
    }
  }
});

test('stage-002 validation rejects missing identities, invalid actions and unsafe error codes before transport', async () => {
  const { repository, calls } = harness([]);
  for (const change of [{ commandId: undefined }, { expectedRevision: -1 }, { note: 'yes' }, { action: 'approve' }, { caseId: '../case' }]) {
    await assert.rejects(() => repository.reviewCase({ ...reviewInput(), ...change }), { code: 'invalid_runtime_input' });
  }
  for (const change of [{ commandId: undefined }, { expectedRevision: 0.1 }, { note: 'yes' }, { requestId: 'request;select' }]) {
    await assert.rejects(() => repository.recoverIntake({ ...recoveryInput(), ...change }), { code: 'invalid_runtime_input' });
  }
  for (const change of [{ fence: 0 }, { requestId: undefined }, ...['9invalid', 'not-valid', 'too_long_'.repeat(11), 'invalid\ncode'].map(errorCode => ({ errorCode }))]) {
    await assert.rejects(() => repository.failIntake({ ...failureInput(), ...change }), { code: 'invalid_runtime_input' });
  }
  assert.equal(calls.length, 0);
});

test('disabling cloud permission after a write blocks readback and leaves its result unresolved', async () => {
  const env = environment();
  const { repository, calls } = harness([() => { env.REFUND_OFFICE_NETWORK = 'offline'; return Response.json(reviewResult()); }], { env });
  await assert.rejects(() => repository.reviewCase(reviewInput()), { code: 'unverified_runtime_response', uncertain: true });
  assert.equal(calls.length, 1);
});
