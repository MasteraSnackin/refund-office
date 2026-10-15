import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createProviders, ProviderError } from '../server/providers.mjs';
import { createApiServer } from '../server/index.mjs';

function setup(t, overrides = {}, dbPath = ':memory:') {
  const store = createStore({ dbPath });
  const local = createProviders({ env: {} });
  const provider = { ...local, ...overrides };
  const engine = createEngine({ store, provider });
  t.after(() => { try { store.close(); } catch { /* A restart test may already have closed it. */ } });
  return { store, provider, engine, local };
}
async function advance(engine, item) { return engine.advance(item.id, { expectedRevision: item.revision }); }
async function approve(engine, item) {
  return engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I reviewed the evidence and approve this exact test refund.' });
}
async function complete(engine, id = 'missing-item') {
  let item = await engine.run(id);
  for (let step = 0; step < 10; step++) {
    if (item.status === 'running') item = await advance(engine, item);
    else if (item.outcome === 'awaiting-approval') item = await approve(engine, item);
    else break;
  }
  assert.notEqual(item.status, 'running');
  return item;
}
async function atPayments(engine, id = 'missing-item') {
  let item = await engine.run(id);
  for (let step = 0; item.stage !== 'payments' && step < 8; step++) {
    if (item.status === 'running') item = await advance(engine, item);
    else if (item.outcome === 'awaiting-approval') item = await approve(engine, item);
    else break;
  }
  return item;
}

test('fresh cases have no prefilled passes; seeded history belongs only to order 106', (t) => {
  const { engine, store } = setup(t);
  const data = engine.bootstrap();
  assert.equal(data.cases.length, 3); assert.equal(data.orders.length, 5);
  assert.ok(data.cases.every((item) => item.status === 'ready' && item.checks.every((check) => check.status === 'not_checked')));
  assert.equal(store.operations('DEMO-104').length, 0);
  assert.equal(store.operations('DEMO-106')[0].receipt.id, 'DEMO-REMEDY-106');
});

test('missing item completes through real server operations and persists the exact payload before provider call', async (t) => {
  const { engine, store, provider, local } = setup(t);
  let calls = 0;
  provider.createRefund = async (payload) => {
    calls++;
    const operation = store.operation(payload.operationId);
    assert.equal(operation.status, 'pending'); assert.ok(operation.submittedAt);
    assert.deepEqual(operation.payload, payload);
    assert.equal(operation.provider, 'local');
    return local.createRefund(payload);
  };
  const item = await complete(engine);
  assert.equal(item.stage, 'archive'); assert.equal(item.outcome, 'refunded');
  assert.equal(item.proposedAmountMinor, 2000); assert.equal(item.receipt.amountMinor, 2000);
  assert.equal(item.receipt.status, 'succeeded'); assert.equal(calls, 1);
  assert.ok(item.checks.every((check) => check.status === 'pass'));
  assert.equal(item.policySnapshot.version, 1);
  assert.ok(item.evidence.some((record) => record.id === 'packing:DEMO-104'));
  assert.ok(item.events.some((event) => event.label === 'Refund operation reserved'));
});

test('policy limit holds the same claim and a changed policy can authorise its replay', async (t) => {
  const { engine, store } = setup(t);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await complete(engine);
  assert.equal(held.status, 'review'); assert.equal(held.outcome, 'held');
  assert.equal(held.checks.find((check) => check.id === 'mandate').status, 'hold');
  assert.match(held.summary, /£20\.00 exceeds.*£10\.00 refund policy limit/);
  assert.equal(store.operations('DEMO-104').length, 0);
  engine.updatePolicy({ limitMinor: 2500 });
  const done = await complete(engine);
  assert.equal(done.outcome, 'refunded'); assert.equal(done.policySnapshot.version, 3);
});

test('policy is revalidated after reservation and before submission; saved reservation can be resumed after review', async (t) => {
  const { engine, provider, local, store } = setup(t);
  let calls = 0; provider.createRefund = async (payload) => { calls++; return local.createRefund(payload); };
  const prepared = await atPayments(engine);
  const original = store.operation(prepared.operationId);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await advance(engine, prepared);
  assert.equal(held.status, 'review'); assert.equal(calls, 0);
  assert.equal(store.operation(original.id).status, 'reserved');
  engine.updatePolicy({ limitMinor: 2500 });
  const done = await complete(engine);
  assert.equal(done.outcome, 'refunded'); assert.equal(calls, 1);
  assert.equal(done.operationId, original.id);
  assert.deepEqual(store.operation(original.id).payload, original.payload);
});

test('conflicting delivery evidence and unknown complaints stop at Review without a payment operation', async (t) => {
  const { engine, store } = setup(t);
  const conflict = await complete(engine, 'conflicting-evidence');
  assert.equal(conflict.status, 'review'); assert.equal(conflict.receipt, null);
  assert.equal(store.operations('DEMO-105').length, 0);
  const unknown = engine.createCase({ orderId: 'DEMO-107', complaint: 'Please tell me about your return options.' });
  const result = await complete(engine, unknown.id);
  assert.equal(result.status, 'review'); assert.equal(store.operations('DEMO-107').length, 0);
  for (const id of ['amount', 'mandate', 'balance']) {
    const check = result.checks.find((entry) => entry.id === id);
    assert.equal(check.status, 'not_checked');
    assert.equal(check.detail, 'No supported refund amount to assess.');
  }
  assert.doesNotMatch(result.summary, /authorise more|exceeds|not have enough|insufficient balance/);
  assert.ok(result.summary.length <= 280);
  assert.equal(result.summary, result.proposal.reason);
});

test('arbitrary new complaint can investigate the fresh £12 order', async (t) => {
  const { engine } = setup(t);
  const item = engine.createCase({ orderId: 'DEMO-107', complaint: 'My pencil case is missing from the parcel. Please refund it.' });
  const done = await complete(engine, item.id);
  assert.equal(done.proposedAmountMinor, 1200); assert.equal(done.receipt.amountMinor, 1200);
  assert.equal(done.outcome, 'refunded');
});

test('duplicate cases and replay reuse the original receipt without a second payment call', async (t) => {
  const { engine, provider, local, store } = setup(t);
  let calls = 0; provider.createRefund = async (payload) => { calls++; return local.createRefund(payload); };
  const first = await complete(engine);
  const replay = await complete(engine);
  assert.equal(replay.outcome, 'already-resolved'); assert.deepEqual(replay.receipt, first.receipt);
  const duplicate = engine.createCase({ orderId: 'DEMO-104', complaint: 'The travel mug is missing. Could you return its price?' });
  const repeated = await complete(engine, duplicate.id);
  assert.equal(repeated.outcome, 'already-resolved'); assert.deepEqual(repeated.receipt, first.receipt);
  assert.equal(store.operations('DEMO-104').length, 1); assert.equal(calls, 1);
  const seeded = await complete(engine, 'repeat-request');
  assert.equal(seeded.outcome, 'already-resolved'); assert.equal(seeded.receipt.id, 'DEMO-REMEDY-106');
});

test('concurrent duplicate investigations reserve only one operation and reconcile that result', async (t) => {
  const { engine, provider, local, store } = setup(t);
  let calls = 0; provider.createRefund = async (payload) => { calls++; return local.createRefund(payload); };
  const duplicate = engine.createCase({ orderId: 'DEMO-104', complaint: 'The travel mug is missing from my parcel.' });
  const [first, second] = await Promise.all([atPayments(engine), atPayments(engine, duplicate.id)]);
  assert.equal(first.status, 'running'); assert.equal(second.status, 'pending');
  assert.equal(first.operationId, second.operationId);
  assert.equal(store.operations('DEMO-104').length, 1);
  const done = await advance(engine, first);
  const linked = await engine.reconcile(second.id);
  assert.equal(linked.outcome, 'already-resolved'); assert.equal(linked.receipt.id, done.receipt.id);
  assert.equal(calls, 1);
});

test('stale and concurrent advances are rejected rather than repeating work', async (t) => {
  const { engine } = setup(t);
  const item = await engine.run('missing-item');
  const results = await Promise.allSettled([advance(engine, item), advance(engine, item)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected').reason;
  assert.equal(rejected.status, 409); assert.equal(rejected.code, 'stale_revision');
  await assert.rejects(engine.advance(item.id, {}), (error) => error.status === 400);
});

test('pause preserves evidence and resume continues the saved stage', async (t) => {
  const { engine } = setup(t);
  const started = await engine.run('missing-item');
  const evidence = await advance(engine, started);
  const paused = await engine.pause(evidence.id);
  assert.equal(paused.stage, 'evidence'); assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.evidence, evidence.evidence);
  await assert.rejects(advance(engine, paused), (error) => error.status === 409);
  const resumed = await engine.resume(paused.id);
  assert.equal((await advance(engine, resumed)).stage, 'policy');
});

test('SQLite restart preserves receipt, policy and case history; unfinished cases recover paused', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.sqlite');
  const first = setup(t, {}, path);
  const done = await complete(first.engine);
  first.engine.updatePolicy({ limitMinor: 1900 });
  const unfinished = await first.engine.run('conflicting-evidence');
  first.store.close();
  const second = setup(t, {}, path);
  assert.deepEqual(second.engine.getCase(done.id), done);
  assert.equal(second.engine.bootstrap().policy.limitMinor, 1900);
  const recovered = second.engine.getCase(unfinished.id);
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.revision, unfinished.revision + 1);
  const replay = await complete(second.engine);
  assert.equal(replay.outcome, 'already-resolved'); assert.equal(replay.receipt.id, done.receipt.id);
});

test('uncertain provider response preserves the exact operation and reconciles without a new key', async (t) => {
  const { engine, provider, local, store } = setup(t);
  let original;
  provider.createRefund = async (payload) => { original = payload; throw new ProviderError('provider_timeout', 'The provider did not confirm a result.', { retryable: true }); };
  provider.retrieveRefund = async ({ operation }) => {
    assert.deepEqual(operation.payload, original);
    assert.equal(operation.idempotencyKey, original.idempotencyKey);
    return local.createRefund(operation.payload);
  };
  const pending = await complete(engine);
  assert.equal(pending.status, 'pending'); assert.equal(pending.receipt, null);
  await assert.rejects(engine.run(pending.id), (error) => error.status === 409);
  const confirmed = await engine.reconcile(pending.id);
  assert.equal(confirmed.outcome, 'refunded'); assert.equal(store.operations('DEMO-104').length, 1);
});

test('provider pending status remains unresolved until retrieved; explicit failed stays failed', async (t) => {
  const { engine, provider, local } = setup(t);
  provider.createRefund = async (payload) => ({ ...await local.createRefund(payload), status: 'pending' });
  provider.retrieveRefund = async ({ receipt }) => ({ ...receipt, status: 'succeeded' });
  const pending = await complete(engine);
  assert.equal(pending.status, 'pending'); assert.equal(pending.receipt.status, 'pending');
  assert.equal((await engine.reconcile(pending.id)).status, 'complete');
  const second = setup(t, { createRefund: async (payload) => ({ ...await local.createRefund(payload), status: 'failed' }) });
  const failed = await complete(second.engine);
  assert.equal(failed.status, 'error'); assert.equal(failed.outcome, 'failed'); assert.equal(failed.receipt.status, 'failed');
  const replay = await complete(second.engine);
  assert.equal(replay.status, 'error'); assert.equal(replay.receipt.id, failed.receipt.id);
});

test('an uncertain payment survives restart with its provider, payload and original retry key', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-pending-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.sqlite');
  const first = setup(t, { createRefund: async () => { throw new ProviderError('timeout', 'The provider did not confirm the result.', { retryable: true }); } }, path);
  const pending = await complete(first.engine);
  const original = first.store.operation(pending.operationId);
  first.store.close();
  const second = setup(t, {}, path);
  second.provider.retrieveRefund = async ({ operation }) => {
    assert.equal(operation.provider, 'local');
    assert.equal(operation.idempotencyKey, original.idempotencyKey);
    assert.deepEqual(operation.payload, original.payload);
    return second.local.createRefund(operation.payload);
  };
  assert.equal(second.engine.getCase(pending.id).status, 'pending');
  const done = await second.engine.reconcile(pending.id);
  assert.equal(done.outcome, 'refunded');
  assert.equal(second.store.operations('DEMO-104').length, 1);
});

test('changing the provider after reservation cannot submit the operation to a different provider', async (t) => {
  const { engine, provider, store } = setup(t);
  const reserved = await atPayments(engine);
  provider.capabilities = () => ({ analyser: 'local', payments: 'stripe-sandbox', modelConfigured: false, stripeConfigured: true });
  provider.createRefund = async () => { throw new Error('A different provider must not be called.'); };
  const held = await advance(engine, reserved);
  assert.equal(held.status, 'review'); assert.match(held.summary, /provider changed/);
  assert.equal(store.operation(reserved.operationId).status, 'reserved');
  assert.equal(store.operation(reserved.operationId).submittedAt, undefined);
});

test('advisory model cannot authorise an invented amount, line or evidence reference', async (t) => {
  for (const patch of [{ amountMinor: 100 }, { lineId: '104-2' }, { evidenceIds: ['invented-record'] }]) {
    const { engine, provider, local, store } = setup(t);
    provider.proposeCase = async (input) => ({ ...await local.proposeCase(input), ...patch, source: 'openai' });
    const result = await complete(engine);
    assert.equal(result.status, 'review'); assert.equal(store.operations('DEMO-104').length, 0);
  }
});

test('mismatched provider amount or identity remains unverified rather than successful', async (t) => {
  for (const patch of [{ amountMinor: 100 }, { provider: 'stripe-sandbox' }, { livemode: true }]) {
    const { engine, provider, local } = setup(t);
    provider.createRefund = async (payload) => ({ ...await local.createRefund(payload), ...patch });
    const result = await complete(engine);
    assert.equal(result.status, 'pending'); assert.equal(result.receipt, null);
  }
});

test('input validation rejects unknown orders, empty complaints and fractional policy values', (t) => {
  const { engine } = setup(t);
  for (const input of [null, {}, { orderId: 'unknown', complaint: 'Missing item' }, { orderId: 'DEMO-104', complaint: 'short' }, { orderId: 'DEMO-104', complaint: 'x'.repeat(4001) }]) assert.throws(() => engine.createCase(input), (error) => error.status === 400);
  for (const limitMinor of [-1, 1.2, 100001, NaN, '2500']) assert.throws(() => engine.updatePolicy({ limitMinor }), (error) => error.status === 400);
  assert.throws(() => engine.getCase('unknown'), (error) => error.status === 404);
});

test('decision packet includes the evidence, rule version, provider result and durable operation', async (t) => {
  const { engine } = setup(t);
  const done = await complete(engine);
  const packet = engine.exportCase(done.id);
  assert.equal(packet.case.receipt.id, done.receipt.id);
  assert.equal(packet.operation.id, done.operationId);
  assert.equal(packet.operation.status, 'succeeded'); assert.equal(packet.operation.executionPolicy.version, 1);
  assert.ok(packet.operation.idempotencyKey); assert.equal(packet.dataMode, 'synthetic-orders');
  assert.ok(packet.case.evidence.length > 0); assert.ok(packet.case.events.length > 0);
});

test('local HTTP API enforces host, origin, JSON and body bounds, and exposes the exact contract', async (t) => {
  const { engine } = setup(t);
  const server = createApiServer({ engine });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${path}`, { method: options.method || 'GET', headers: { Host: '127.0.0.1:4174', ...(options.headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(options.body || undefined);
  });
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.status, 200); assert.equal((await bootstrap.json()).cases.length, 3);
  assert.equal((await request('/api/bootstrap', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/api/bootstrap', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/api/cases/missing-item/run', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await request('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid' })).status, 400);
  assert.equal((await request('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ complaint: 'a'.repeat(17000) }) })).status, 413);
  const run = await request('/api/cases/missing-item/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4173' }, body: '{}' });
  assert.equal(run.status, 200); assert.equal(run.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
  const running = await run.json(); assert.equal(running.status, 'running');
  const advance = await request('/api/cases/missing-item/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) });
  assert.equal(advance.status, 409); assert.equal((await advance.json()).error.code, 'stale_revision');
  const packet = await request('/api/cases/missing-item/export');
  assert.match(packet.headers.get('content-disposition'), /RF-104-decision-packet.json/);
});
