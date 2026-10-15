import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimePaymentExecutor, createRuntimePaymentRepository, createRuntimeStripeTestProvider } from '../server/runtime-payments.mjs';
import { ENABLED, executionFixture, providerFixture, repositoryFixture } from './runtime-payments/fixtures.mjs';

function setup(options = {}) {
  const e = executionFixture(), log = [], { repository, state } = repositoryFixture(e, log), provider = providerFixture(e, log, options);
  return { e, log, repository, provider, state, executor: () => createRuntimePaymentExecutor({ env: ENABLED, repository, provider }) };
}
test('execution remains disconnected before repository, provider or secret access', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('Disconnected dependency accessed'); } });
  for (const env of [{}, { ...ENABLED, REFUND_OFFICE_NETWORK: 'offline' }, { ...ENABLED, REFUND_OFFICE_ENABLED_INTEGRATIONS: 'stripe' }]) {
    Object.defineProperty(env, 'STRIPE_SECRET_KEY', { get() { assert.fail('Secret read offline'); } });
    await assert.rejects(createRuntimePaymentExecutor({ env, repository: forbidden, provider: forbidden }).execute(executionFixture().id), { code: 'payment_execution_disabled' });
    await assert.rejects(createRuntimeStripeTestProvider({ env, fetchImpl: forbidden }).readAccount(), { code: 'payment_execution_disabled' });
    await assert.rejects(createRuntimePaymentRepository({ env, tenantId: executionFixture().tenantId, rpc() { assert.fail('RPC called offline'); } }).readExecution(executionFixture().id), { code: 'payment_execution_disabled' });
  }
});
test('one exact POST follows saved independently read intent; independent refund retrieval precedes confirmation', async () => {
  const s = setup(), original = structuredClone(s.state.originalOperation);
  const result = await s.executor().execute(s.e.id);
  assert.deepEqual(s.log, ['claim','account:get','payment:get','charge:get','intent:save','execution:get','refund:post','reference:save','execution:get','refund:get','readback:save','execution:get']);
  assert.equal(result.execution.status, 'succeeded'); assert.equal(result.readbackVerified, true); assert.equal(result.liveVerified, false);
  assert.deepEqual(s.state.originalOperation, original);
});
test('a wrong account, live PaymentIntent, wrong order, insufficient charge or changed payload cannot submit', async () => {
  for (const mutate of [
    s => { s.provider.readAccount = async () => ({ id: 'acct_Wrong' }); },
    s => { const read = s.provider.readPaymentIntent; s.provider.readPaymentIntent = async id => ({ ...await read(id), livemode: true }); },
    s => { const read = s.provider.readPaymentIntent; s.provider.readPaymentIntent = async id => ({ ...await read(id), metadata: { refund_office_order_id: 'SYN-WRONG', refund_office_tenant_id: s.e.tenantId } }); },
    s => { const read = s.provider.readCharge; s.provider.readCharge = async id => ({ ...await read(id), amount_refunded: 5000 }); },
    s => { s.state.payload.amountMinor++; },
  ]) { const s = setup(); mutate(s); await assert.rejects(s.executor().execute(s.e.id)); assert.equal(s.log.includes('refund:post'), false); assert.equal(s.state.submittedAt, null); }
});
test('a lost submission response is durable uncertainty with no receiptless retry or replacement key', async () => {
  const s = setup(), key = s.e.idempotencyKey;
  s.provider.createRefund = async () => { s.log.push('refund:post'); throw new Error('Synthetic lost response'); };
  await assert.rejects(s.executor().execute(s.e.id), e => e.code === 'payment_execution_uncertain' && e.uncertain);
  assert.ok(s.state.submittedAt); assert.equal(s.state.status, 'uncertain'); assert.equal(s.state.refundId, null);
  await assert.rejects(s.executor().execute(s.e.id)); await assert.rejects(s.executor().reconcile(s.e.id));
  assert.equal(s.log.filter(x => x === 'refund:post').length, 1); assert.equal(s.state.idempotencyKey, key);
});
test('lost durable-intent acknowledgement prevents POST and holds uncertainty', async () => {
  const s = setup(), begin = s.repository.beginSubmission;
  s.repository.beginSubmission = async input => { await begin(input); throw new Error('Lost acknowledgement'); };
  await assert.rejects(s.executor().execute(s.e.id), { code: 'payment_execution_uncertain' });
  assert.ok(s.state.submittedAt); assert.equal(s.state.status, 'uncertain'); assert.equal(s.log.includes('refund:post'), false);
});
test('changed intent readback or expired claim cannot reach POST', async () => {
  const s = setup(), read = s.repository.readExecution;
  s.repository.readExecution = async () => ({ ...await read(), payloadDigest: 'c'.repeat(64) });
  await assert.rejects(s.executor().execute(s.e.id), { code: 'payment_execution_uncertain' });
  assert.equal(s.log.includes('refund:post'), false);
  const t = setup(), claim = t.repository.claimExecution;
  t.repository.claimExecution = async () => ({ ...await claim(), leaseUntil: '2020-01-01T00:00:00Z' });
  await assert.rejects(t.executor().execute(t.e.id), { code: 'stale_execution_lease' }); assert.equal(t.log.includes('refund:post'), false);
});
test('a returned success cannot settle unless independent retrieval matches exact refund identity and amount', async () => {
  const s = setup(); s.provider.readRefund = async () => ({ id: 're_Wrong', amount: 1, status: 'succeeded' });
  await assert.rejects(s.executor().execute(s.e.id), { code: 'payment_execution_uncertain' });
  assert.equal(s.state.refundId, 're_Synthetic1'); assert.equal(s.state.receipt, null); assert.equal(s.state.status, 'uncertain');
});
test('a known pending refund reconciles through GET only, without requiring balance before its own refund', async () => {
  const s = setup({ status: 'pending' }); await s.executor().execute(s.e.id);
  assert.equal(s.state.status, 'pending');
  const p = providerFixture(s.e, s.log), readCharge = p.readCharge;
  Object.assign(s.provider, p, { readCharge: async id => ({ ...await readCharge(id), amount_refunded: 6000 }) });
  const before = s.log.length; const result = await s.executor().reconcile(s.e.id);
  assert.equal(result.execution.status, 'succeeded'); assert.deepEqual(s.log.slice(before), ['reconcile:claim','account:get','payment:get','charge:get','refund:get','readback:save','execution:get']);
  assert.equal(s.log.filter(x => x === 'refund:post').length, 1);
});
test('prepared transport rejects live keys and encodes only exact saved refund values', async () => {
  await assert.rejects(createRuntimeStripeTestProvider({ env: { ...ENABLED, STRIPE_SECRET_KEY: 'sk_live_SyntheticOnly' }, fetchImpl() { assert.fail('Live key called transport'); } }).readAccount(), { code: 'stripe_test_key_required' });
  const calls = [], e = executionFixture();
  const provider = createRuntimeStripeTestProvider({ env: { ...ENABLED, STRIPE_SECRET_KEY: 'sk_test_SyntheticOnly' }, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 're_Synthetic1' })); } });
  await provider.createRefund(e.payload);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/refunds'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Idempotency-Key'], e.idempotencyKey); assert.equal(calls[0].options.headers['Stripe-Account'], undefined);
  assert.equal(calls[0].options.body.get('amount'), '2000'); assert.equal(calls[0].options.body.get('payment_intent'), e.mapping.paymentIntentId);
});
test('repository forwards only exact domain parameters and rejects another tenant response', async () => {
  const e = executionFixture(), calls = [];
  const repository = createRuntimePaymentRepository({ env: ENABLED, tenantId: e.tenantId, rpc: async (...args) => { calls.push(args); return structuredClone(e); } });
  await repository.claimExecution({ executionId: e.id, leaseSeconds: 30, actor: 'injected-actor' });
  assert.deepEqual(calls[0], ['refund_runtime_claim_execution', { p_tenant_id: e.tenantId, p_execution_id: e.id, p_lease_seconds: 30 }]);
  const bad = createRuntimePaymentRepository({ env: ENABLED, tenantId: '70000000-0000-4000-8000-000000000012', rpc: async () => e });
  await assert.rejects(bad.readExecution(e.id), { code: 'unverified_execution' });
  await assert.rejects(repository.readExecution('70000000-0000-4000-8000-000000000001'), { code: 'unverified_execution' });
  await assert.rejects(repository.authoriseExecution({ operationId: e.operationId, expectedCaseRevision: e.authorisation.caseRevision, originalApprovalId: e.originalApproval.id, originalFingerprint: e.authorisation.originalFingerprint, expectedAmountMinor: e.payload.amountMinor + 1, mapping: e.mapping, note: e.authorisation.note, commandId: e.id }), { code: 'unverified_execution' });
});
test('malformed mutation acknowledgements retain uncertainty because the database may have committed', async () => {
  const e = executionFixture();
  const repo = createRuntimePaymentRepository({ env: ENABLED, tenantId: e.tenantId, rpc: async () => ({ id: e.id }) });
  await assert.rejects(repo.claimExecution({ executionId: e.id }), error => error.code === 'unverified_execution' && error.uncertain === true);
  await assert.rejects(repo.authoriseExecution({ operationId: e.operationId }), error => error.code === 'unverified_execution' && error.uncertain === true);
  await assert.rejects(repo.readExecution(e.id), error => error.code === 'unverified_execution' && error.uncertain === false);
});
