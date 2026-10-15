import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, ProviderError } from '../server/providers.mjs';
import { ORDERS, SEED_CASES } from '../server/fixtures.mjs';

const order = { id: 'DEMO-104', totalMinor: 6000, currency: 'gbp', lines: [{ id: 'line-1', name: 'Mug', unitAmountMinor: 2000, ordered: 1, packed: 1 }, { id: 'line-2', name: 'Bottle', unitAmountMinor: 2000, ordered: 1, packed: 1 }, { id: 'line-3', name: 'Notebook', unitAmountMinor: 2000, ordered: 1, packed: 0 }] };
const evidence = [{ id: 'order:DEMO-104' }, { id: 'packing:DEMO-104' }, { id: 'delivery:DEMO-104' }];
const operation = { operationId: 'operation-1', idempotencyKey: 'refund-operation-1', order, amountMinor: 2000, lineId: 'line-3', issue: 'item_missing' };
const testEnv = { REFUND_OFFICE_NETWORK: 'enabled', STRIPE_SECRET_KEY: 'sk_test_fakeForUnitTesting' };
const pi = { id: 'pi_test123', livemode: false, amount: 6000, currency: 'gbp', status: 'succeeded', metadata: { refund_office_order_id: order.id } };
const refund = { id: 're_test123', amount: 2000, currency: 'gbp', status: 'succeeded', payment_intent: pi.id, metadata: { operation_id: 'operation-1' }, created: 1760000000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('local analyser requires an explicit supported complaint and matching omitted line', async () => {
  const providers = createProviders({ env: {} });
  const propose = (complaint) => providers.proposeCase({ complaint, order, evidence });
  const result = await propose('My parcel arrived but the notebook is missing. Please refund it.');
  assert.equal(result.amountMinor, 2000);
  assert.equal(result.lineId, 'line-3');
  assert.equal(result.issue, 'item_missing');
  assert.deepEqual(result.evidenceIds, ['order:DEMO-104', 'packing:DEMO-104']);
  assert.equal((await propose('My parcel is missing the notebook. Can you refund that missing item?')).issue, 'item_missing');
  for (const text of ['Please refund everything.', 'Nothing is missing but I want my money back.', 'My notebook is not missing.', 'I am missing my dog.', 'The mug is missing.']) assert.equal((await propose(text)).issue, 'unknown');
  assert.equal((await propose('I have not received the parcel. Tracking says delivered.')).issue, 'delivery_dispute');
});

test('unrelated missing or short wording cannot borrow context from another clause', async () => {
  const providers = createProviders({ env: {} });
  for (const complaint of ['I am short of money after this order. Please refund me.', 'I am missing my dog. My order arrived fine.']) {
    const proposal = await providers.proposeCase({ complaint, order: ORDERS[0], evidence });
    assert.equal(proposal.issue, 'unknown');
    assert.equal(proposal.amountMinor, 0);
    assert.equal(proposal.lineId, null);
  }
});

test('all supplied case wording and the fresh order sample remain supported', async () => {
  const providers = createProviders({ env: {} });
  for (const item of SEED_CASES) {
    const fixture = ORDERS.find((entry) => entry.id === item.orderId);
    const proposal = await providers.proposeCase({ complaint: item.complaint, order: fixture, evidence: [{ id: `order:${fixture.id}` }, { id: `packing:${fixture.id}` }, { id: `delivery:${fixture.id}` }] });
    assert.equal(proposal.issue, item.id === 'conflicting-evidence' ? 'delivery_dispute' : 'item_missing', item.id);
  }
  const fixture = ORDERS.find((entry) => entry.id === 'DEMO-107');
  for (const complaint of ['My pencil case is missing from the parcel. Please refund it.', 'One item from this order is missing. Please check the packing records and refund any item that was not supplied.']) {
    const proposal = await providers.proposeCase({ complaint, order: fixture, evidence: [{ id: 'order:DEMO-107' }, { id: 'packing:DEMO-107' }] });
    assert.equal(proposal.issue, 'item_missing');
    assert.equal(proposal.lineId, '107-3');
    assert.equal(proposal.amountMinor, 1200);
  }
});

test('local receipts use stable operation IDs, reject conflicting reuse and reconcile after restart', async () => {
  const providers = createProviders({ env: {} });
  const first = await providers.createRefund(operation);
  const second = await providers.createRefund(operation);
  assert.deepEqual(first, second);
  assert.match(first.id, /^LOCAL-/);
  assert.equal(first.provider, 'local');
  await assert.rejects(providers.createRefund({ ...operation, amountMinor: 1000 }), { code: 'idempotency_mismatch' });
  const restarted = createProviders({ env: {} });
  assert.deepEqual(await restarted.retrieveRefund({ receipt: first, operation: { id: operation.operationId, payload: operation, provider: 'local' } }), first);
});

test('live and malformed Stripe keys are rejected before any network access', () => {
  for (const key of ['sk_live_notAllowed', 'rk_live_notAllowed', 'arbitrary']) assert.throws(() => createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', STRIPE_SECRET_KEY: key }, fetchImpl: () => assert.fail('network access') }), { code: 'test_key_required' });
});

test('Stripe partial refund is independently retrieved; test-mode check comes from PaymentIntent', async () => {
  const calls = [];
  const providers = createProviders({ env: testEnv, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json(calls.length === 1 ? pi : refund); } });
  const result = await providers.createRefund(operation);
  assert.equal(result.provider, 'stripe-sandbox');
  assert.equal(result.livemode, false);
  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].url, 'https://api.stripe.com/v1/refunds/re_test123');
  assert.equal(calls[1].headers['Idempotency-Key'], operation.idempotencyKey);
  const seed = new URLSearchParams(calls[0].body);
  assert.equal(seed.get('payment_method'), 'pm_card_visa');
  assert.equal(seed.get('automatic_payment_methods[allow_redirects]'), 'never');
  const seedKey = calls[0].headers['Idempotency-Key'];
  calls.length = 0;
  await providers.createRefund({ ...operation, operationId: 'operation-1' });
  assert.equal(calls[0].headers['Idempotency-Key'], seedKey);
});

test('Stripe never requests a refund for an unverified/live/mismatched payment', async () => {
  for (const invalid of [{ ...pi, livemode: true }, { ...pi, amount: 5000 }, { ...pi, status: 'processing' }, { ...pi, metadata: {} }]) {
    let count = 0;
    const providers = createProviders({ env: testEnv, fetchImpl: async () => { count++; return json(invalid); } });
    await assert.rejects(providers.createRefund(operation), ProviderError);
    assert.equal(count, 1);
  }
});

test('Stripe refuses mismatched readback and retains pending instead of assuming success', async () => {
  let call = 0;
  const bad = createProviders({ env: testEnv, fetchImpl: async () => json(++call === 1 ? pi : call === 2 ? refund : { ...refund, amount: 1000 }) });
  await assert.rejects(bad.createRefund(operation), { code: 'refund_mismatch' });
  call = 0;
  const pending = createProviders({ env: testEnv, fetchImpl: async () => json(++call === 1 ? pi : { ...refund, status: 'pending' }) });
  assert.equal((await pending.createRefund(operation)).status, 'pending');
});

test('provider failure is redacted and never replaced with a local success', async () => {
  const providers = createProviders({ env: testEnv, fetchImpl: async () => json({ error: { message: 'secret sk_test_NEVER_ECHO_ME' } }, 500) });
  await assert.rejects(providers.createRefund(operation), (error) => error.code === 'stripe_http_500' && error.retryable && !error.message.includes('NEVER_ECHO'));
});

test('uncertain operations replay the exact key and refuse a changed provider', async () => {
  const calls = [];
  const providers = createProviders({ env: testEnv, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json(calls.length === 1 ? pi : refund); } });
  await providers.retrieveRefund({ operation: { id: operation.operationId, provider: 'stripe-sandbox', submittedAt: new Date().toISOString(), idempotencyKey: operation.idempotencyKey, payload: operation } });
  assert.equal(calls[1].headers['Idempotency-Key'], operation.idempotencyKey);
  const local = createProviders({ env: {} });
  await assert.rejects(local.retrieveRefund({ operation: { id: operation.operationId, provider: 'stripe-sandbox', payload: operation } }), { code: 'provider_changed' });
});

test('an uncertain Stripe operation outside the retry window cannot repeat a POST', async () => {
  const providers = createProviders({ env: testEnv, fetchImpl: () => assert.fail('network access') });
  await assert.rejects(providers.retrieveRefund({ operation: { id: operation.operationId, provider: 'stripe-sandbox', submittedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), payload: operation } }), { code: 'reconciliation_window_expired' });
});

test('Stripe reconciliation checks payment test mode again and re-reads the saved refund', async () => {
  const calls = [];
  const providers = createProviders({ env: testEnv, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json(calls.length === 1 ? pi : refund); } });
  const receipt = { id: refund.id, provider: 'stripe-sandbox', paymentIntentId: pi.id };
  assert.equal((await providers.retrieveRefund({ receipt, operation: { id: operation.operationId, payload: operation } })).status, 'succeeded');
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('OpenAI uses strict Responses schema and does not grant payment authority', async () => {
  let request;
  const proposal = { amountMinor: 2000, lineId: 'line-3', issue: 'item_missing', reason: 'The packing record omits the notebook.', evidenceIds: ['packing:DEMO-104'] };
  const providers = createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'openai', OPENAI_API_KEY: 'private-test-key' }, fetchImpl: async (url, options) => { request = { url, ...options }; return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }); } });
  assert.equal((await providers.proposeCase({ complaint: 'Missing notebook', order, evidence })).source, 'openai');
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.store, false);
  assert.match(body.instructions, /do not authorise/);
  assert.equal(providers.capabilities().payments, 'local');
});

test('incomplete, refused or invalid model proposals fail closed without a local fallback', async () => {
  for (const response of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"amountMinor":999999}' }] }] }]) {
    const providers = createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'openai', OPENAI_API_KEY: 'private-test-key' }, fetchImpl: async () => json(response) });
    await assert.rejects(providers.proposeCase({ complaint: 'Missing notebook', order, evidence }), ProviderError);
  }
});

test('Anthropic requires explicit selection and a model, without borrowing another provider', () => {
  const env = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', ANTHROPIC_API_KEY: 'fake-anthropic-unit-test' };
  assert.throws(() => createProviders({ env }), { code: 'model_required' });
  assert.throws(() => createProviders({ env: { ...env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'fake-openai-unit-test' } }), { code: 'analyser_not_configured' });
  assert.equal(createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', ANTHROPIC_API_KEY: 'fake-anthropic-unit-test' } }).capabilities().analyser, 'local');
  assert.equal(createProviders({ env: { ...env, REFUND_OFFICE_ANALYSER: 'local' } }).capabilities().analyser, 'local');
});

test('Anthropic sends a constrained proposal request and preserves its actual source', async () => {
  const calls = [];
  const proposal = { amountMinor: 2000, lineId: 'line-3', issue: 'item_missing', reason: 'The packing record omits the notebook.', evidenceIds: ['packing:DEMO-104'] };
  const provider = createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', ANTHROPIC_API_KEY: 'fake-anthropic-unit-test', ANTHROPIC_MODEL: 'test-model', OPENAI_API_KEY: 'fake-do-not-use' }, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposal) }] }); } });
  const result = await provider.proposeCase({ complaint: 'My notebook is missing.', order, evidence });
  assert.equal(result.source, 'anthropic');
  assert.equal(result.amountMinor, 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'fake-anthropic-unit-test');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].redirect, 'error');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.output_config.format.schema.properties.amountMinor.minimum, undefined);
  assert.match(body.system, /do not authorise/);
  assert.equal(provider.capabilities().analyser, 'anthropic');
  assert.equal(provider.capabilities().payments, 'local');
});

test('Anthropic refusal, truncation, invalid schema and unsafe numeric output all fail closed', async () => {
  const proposal = { amountMinor: 2000, lineId: 'line-3', issue: 'item_missing', reason: 'Test reason', evidenceIds: ['packing:DEMO-104'] };
  const response = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] });
  const invalid = [
    { stop_reason: 'refusal', content: [] },
    { stop_reason: 'max_tokens', content: [] },
    { stop_reason: 'end_turn', stop_details: { type: 'refusal' }, content: [] },
    response({ ...proposal, amountMinor: -1 }),
    response({ ...proposal, amountMinor: 1.5 }),
    response({ ...proposal, amountMinor: Number.MAX_SAFE_INTEGER + 1 }),
    response({ ...proposal, approval: true }),
    response({ ...proposal, evidenceIds: ['packing:DEMO-104', 4] }),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'invalid json' }] },
  ];
  for (const output of invalid) {
    let calls = 0;
    const provider = createProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', ANTHROPIC_API_KEY: 'fake-anthropic-unit-test', ANTHROPIC_MODEL: 'test-model' }, fetchImpl: async () => { calls++; return json(output); } });
    await assert.rejects(provider.proposeCase({ complaint: 'My notebook is missing.', order, evidence }), ProviderError);
    assert.equal(calls, 1);
  }
});

test('Anthropic errors are redacted and never fall back to OpenAI or local proposals', async () => {
  const env = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', ANTHROPIC_API_KEY: 'fake-anthropic-unit-test', ANTHROPIC_MODEL: 'test-model', OPENAI_API_KEY: 'fake-openai-unit-test' };
  let calls = 0;
  const provider = createProviders({ env, fetchImpl: async () => { calls++; return json({ message: 'NEVER_ECHO_PRIVATE_INPUT' }, 429); } });
  await assert.rejects(provider.proposeCase({ complaint: 'My notebook is missing.', order, evidence }), error => error.code === 'anthropic_http_429' && error.retryable && !error.message.includes('NEVER_ECHO'));
  assert.equal(calls, 1);
});
