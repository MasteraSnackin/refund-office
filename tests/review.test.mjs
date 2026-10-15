import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createProviders } from '../server/providers.mjs';
import { createApiServer } from '../server/index.mjs';

function setup(t, dbPath = ':memory:') {
  const store = createStore({ dbPath });
  const local = createProviders({ env: {} });
  const calls = { analyse: 0, create: 0, retrieve: 0 };
  const provider = {
    ...local,
    proposeCase: async input => { calls.analyse++; return local.proposeCase(input); },
    createRefund: async input => { calls.create++; return local.createRefund(input); },
    retrieveRefund: async input => { calls.retrieve++; return local.retrieveRefund(input); },
  };
  const engine = createEngine({ store, provider });
  t.after(() => { try { store.close(); } catch { /* Restart checks may already have closed it. */ } });
  return { engine, store, provider, calls };
}

async function complete(engine, id = 'conflicting-evidence') {
  let item = await engine.run(id);
  for (let step = 0; step < 10; step++) {
    if (item.status === 'running' || item.outcome === 'awaiting-approval') item = await progress(engine, item);
    else break;
  }
  assert.notEqual(item.status, 'running');
  return item;
}

async function progress(engine, item) {
  return item.outcome === 'awaiting-approval'
    ? engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I reviewed the evidence and approve this exact test refund.' })
    : engine.advance(item.id, { expectedRevision: item.revision });
}

function input(item, action, note = 'Delivery photograph and recipient confirmation are required.') {
  return { action, note, expectedRevision: item.revision };
}

test('recording evidence needed retains the hold, evidence and checks without calling a provider', async t => {
  const { engine, store, calls } = setup(t);
  const held = await complete(engine);
  const originalCalls = { ...calls };
  const note = '  Request a delivery photograph and recipient confirmation.  ';
  const requested = await engine.review(held.id, { ...input(held, 'request-evidence', note), actor: 'pretend-administrator' });
  assert.equal(requested.status, 'review'); assert.equal(requested.outcome, 'held'); assert.equal(requested.stage, 'review');
  assert.equal(requested.review.state, 'awaiting-evidence');
  assert.equal(requested.review.note, note.trim()); assert.equal(requested.review.actor, 'local-reviewer');
  assert.ok(Number.isFinite(Date.parse(requested.review.decidedAt)));
  assert.equal(requested.revision, held.revision + 1);
  for (const field of ['evidence', 'checks', 'proposal', 'policySnapshot', 'receipt']) assert.deepEqual(requested[field], held[field]);
  assert.deepEqual(requested.events.slice(0, -1), held.events);
  assert.match(requested.events.at(-1).label, /internal request recorded/);
  assert.match(requested.events.at(-1).detail, /Nothing was sent externally/);
  assert.equal(requested.events.at(-1).station, 'review');
  assert.deepEqual(calls, originalCalls); assert.equal(store.operations(held.orderId).length, 0);
});

test('closure archives the case without a payment; reopening is explicit and preserves earlier decisions', async t => {
  const { engine, store, calls } = setup(t);
  const held = await complete(engine);
  const waiting = await engine.review(held.id, input(held, 'request-evidence', 'The courier delivery photograph is still required.'));
  const closed = await engine.review(held.id, input(waiting, 'close-no-refund', 'Customer withdrew the refund request after reviewing the records.'));
  assert.equal(closed.status, 'closed'); assert.equal(closed.outcome, 'closed-no-refund'); assert.equal(closed.stage, 'archive');
  assert.equal(closed.review.state, 'closed'); assert.equal(closed.receipt, null); assert.equal(closed.operationId, undefined);
  assert.deepEqual(closed.checks, held.checks); assert.deepEqual(closed.evidence, held.evidence);
  await assert.rejects(engine.run(closed.id), error => error.status === 409 && error.code === 'case_closed');
  await assert.rejects(engine.advance(closed.id, { expectedRevision: closed.revision }), error => error.status === 409);
  const reopened = await engine.review(closed.id, input(closed, 'reopen', 'The customer has asked us to reconsider the delivery evidence.'));
  assert.equal(reopened.status, 'review'); assert.equal(reopened.outcome, 'held'); assert.equal(reopened.stage, 'review');
  assert.equal(reopened.review.state, 'open'); assert.equal(reopened.revision, closed.revision + 1);
  assert.deepEqual(reopened.events.slice(0, -1), closed.events);
  assert.ok(reopened.events.some(event => event.detail.includes('Customer withdrew')));
  assert.ok(reopened.events.some(event => event.detail.includes('photograph is still required')));
  assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0); assert.equal(store.operations(held.orderId).length, 0);
  const rechecked = await complete(engine, reopened.id);
  assert.equal(rechecked.status, 'review'); assert.equal(rechecked.receipt, null);
  assert.equal(rechecked.review.state, 'open');
  assert.equal(calls.create, 0);
});

test('reinvestigation clears the waiting marker and retains the recorded evidence request', async t => {
  const { engine } = setup(t);
  const held = await complete(engine);
  const waiting = await engine.review(held.id, input(held, 'request-evidence'));
  const restarted = await engine.run(held.id);
  assert.equal(restarted.status, 'running'); assert.equal(restarted.review.state, 'open');
  assert.equal(restarted.review.note, waiting.review.note);
  assert.deepEqual(restarted.events.slice(0, -1), waiting.events);
});

test('stale and repeated review clicks cannot record multiple decisions', async t => {
  const { engine } = setup(t);
  const held = await complete(engine);
  const body = input(held, 'close-no-refund', 'The customer no longer requests a refund for this order.');
  const attempts = await Promise.allSettled([engine.review(held.id, body), engine.review(held.id, body)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const failure = attempts.find(result => result.status === 'rejected').reason;
  assert.equal(failure.code, 'stale_revision'); assert.equal(failure.status, 409);
  const closed = engine.getCase(held.id);
  assert.equal(closed.revision, held.revision + 1); assert.equal(closed.events.length, held.events.length + 1);
  await assert.rejects(engine.review(held.id, body), error => error.code === 'stale_revision');
  await assert.rejects(engine.review(held.id, input(closed, 'close-no-refund')), error => error.code === 'review_action_unavailable');
});

test('invalid review bodies do not change the saved case', async t => {
  const { engine } = setup(t);
  const held = await complete(engine);
  const valid = input(held, 'request-evidence');
  const bodies = [null, {}, { ...valid, action: 'approve-refund' }, { ...valid, action: 'close_without_refund' },
    { ...valid, note: null }, { ...valid, note: ' short ' }, { ...valid, note: ' '.repeat(12) }, { ...valid, note: 'x'.repeat(1001) },
    { ...valid, expectedRevision: undefined }, { ...valid, expectedRevision: '3' }, { ...valid, expectedRevision: 1.5 }, { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }];
  for (const body of bodies) await assert.rejects(engine.review(held.id, body), error => error.status === 400);
  assert.deepEqual(engine.getCase(held.id), held);
  await assert.rejects(engine.review('missing-case', valid), error => error.status === 404);
});

test('review decisions are unavailable for ready, running, paused and completed cases', async t => {
  const { engine } = setup(t);
  const ready = engine.getCase('missing-item');
  const attempt = async item => {
    for (const action of ['request-evidence', 'close-no-refund', 'reopen']) await assert.rejects(engine.review(item.id, input(item, action)), error => error.status === 409);
    assert.deepEqual(engine.getCase(item.id), item);
  };
  await attempt(ready);
  const running = await engine.run(ready.id); await attempt(running);
  const paused = await engine.pause(ready.id); await attempt(paused);
  let done = await engine.resume(ready.id);
  while (done.status === 'running' || done.outcome === 'awaiting-approval') done = await progress(engine, done);
  await attempt(done);
});

test('reserved operations and original receipts cannot be hidden by a review decision', async t => {
  const { engine, store } = setup(t);
  let prepared = await engine.run('missing-item');
  while (prepared.stage !== 'payments') prepared = await progress(engine, prepared);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await engine.advance(prepared.id, { expectedRevision: prepared.revision });
  assert.equal(held.status, 'review');
  const operation = store.operation(held.operationId);
  for (const action of ['request-evidence', 'close-no-refund', 'reopen']) await assert.rejects(engine.review(held.id, input(held, action)), error => error.code === 'payment_operation_exists');
  assert.deepEqual(store.operation(held.operationId), operation); assert.deepEqual(engine.getCase(held.id), held);
  engine.updatePolicy({ limitMinor: 2500 });
  const paid = await complete(engine, held.id);
  const originalReceipt = paid.receipt;
  for (const action of ['request-evidence', 'close-no-refund', 'reopen']) await assert.rejects(engine.review(paid.id, input(paid, action)), error => error.code === 'payment_operation_exists');
  assert.deepEqual(engine.getCase(paid.id).receipt, originalReceipt);
  assert.equal(store.operations(paid.orderId).length, 1);
});

test('pending and failed payment cases retain their reconciliation records', async t => {
  for (const paymentStatus of ['pending', 'failed']) {
    const { engine, store, provider } = setup(t);
    const originalCreate = provider.createRefund;
    provider.createRefund = async value => ({ ...await originalCreate(value), status: paymentStatus });
    const item = await complete(engine, 'missing-item');
    const operation = store.operation(item.operationId);
    for (const action of ['request-evidence', 'close-no-refund', 'reopen']) await assert.rejects(engine.review(item.id, input(item, action)), error => error.code === 'payment_operation_exists');
    assert.deepEqual(engine.getCase(item.id), item); assert.deepEqual(store.operation(item.operationId), operation);
  }
});

test('a later case refund prevents a stale held case from recording a no-refund closure or evidence request', async t => {
  const { engine, store, calls } = setup(t);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await complete(engine, 'missing-item');
  assert.equal(held.status, 'review'); assert.equal(held.operationId, undefined);
  engine.updatePolicy({ limitMinor: 2500 });
  const duplicate = engine.createCase({ orderId: held.orderId, complaint: 'The travel mug is missing from my parcel. Please refund it.' });
  const paid = await complete(engine, duplicate.id);
  assert.equal(paid.outcome, 'refunded');
  const originalOperation = store.operation(paid.operationId);
  const originalCalls = { ...calls };
  for (const action of ['request-evidence', 'close-no-refund']) {
    await assert.rejects(engine.review(held.id, input(held, action)), error => error.status === 409 && error.code === 'related_payment_operation_exists' && /Inspect its result or investigate/.test(error.message));
  }
  assert.deepEqual(calls, originalCalls);
  assert.deepEqual(engine.getCase(held.id), held); assert.deepEqual(engine.getCase(paid.id), paid);
  assert.deepEqual(store.operation(paid.operationId), originalOperation);
  const linked = await complete(engine, held.id);
  assert.equal(linked.outcome, 'already-resolved'); assert.equal(linked.receipt.id, paid.receipt.id);
  assert.equal(calls.create, originalCalls.create);
});

test('a cross-case reservation blocks review decisions before any payment has been submitted', async t => {
  const { engine, store, calls } = setup(t);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await complete(engine, 'missing-item');
  engine.updatePolicy({ limitMinor: 2500 });
  const duplicate = engine.createCase({ orderId: held.orderId, complaint: 'The travel mug was not sent. Please refund the missing item.' });
  let prepared = await engine.run(duplicate.id);
  while (prepared.stage !== 'payments') prepared = await progress(engine, prepared);
  const operation = store.operation(prepared.operationId);
  assert.equal(operation.status, 'reserved'); assert.equal(operation.submittedAt, undefined);
  const originalCalls = { ...calls };
  for (const action of ['request-evidence', 'close-no-refund']) await assert.rejects(engine.review(held.id, input(held, action)), error => error.code === 'related_payment_operation_exists');
  assert.deepEqual(calls, originalCalls); assert.equal(calls.create, 0);
  assert.deepEqual(engine.getCase(held.id), held); assert.deepEqual(store.operation(prepared.operationId), operation);
});

test('unsupported case identity uses an order-wide check for later remedies', async t => {
  const { engine, calls } = setup(t);
  const unclear = engine.createCase({ orderId: 'DEMO-104', complaint: 'Please tell me about your return options.' });
  const held = await complete(engine, unclear.id);
  assert.equal(held.status, 'review'); assert.equal(held.proposal.lineId, null);
  const paid = await complete(engine, 'missing-item');
  const originalCalls = { ...calls };
  await assert.rejects(engine.review(held.id, input(held, 'close-no-refund')), error => error.code === 'related_payment_operation_exists');
  assert.deepEqual(calls, originalCalls); assert.deepEqual(engine.getCase(held.id), held);
  assert.deepEqual(engine.getCase(paid.id), paid);
});

test('explicit reopening remains available after another case records a later refund', async t => {
  const { engine, calls } = setup(t);
  engine.updatePolicy({ limitMinor: 1000 });
  const held = await complete(engine, 'missing-item');
  const closed = await engine.review(held.id, input(held, 'close-no-refund', 'The customer withdrew this request before a refund was authorised.'));
  engine.updatePolicy({ limitMinor: 2500 });
  const duplicate = engine.createCase({ orderId: held.orderId, complaint: 'The travel mug is missing from my parcel. Please refund it.' });
  const paid = await complete(engine, duplicate.id);
  const originalCalls = { ...calls };
  const reopened = await engine.review(closed.id, input(closed, 'reopen', 'A later case may have resolved the same item. Recheck its recorded result.'));
  assert.equal(reopened.status, 'review'); assert.equal(reopened.review.state, 'open');
  assert.deepEqual(calls, originalCalls);
  const linked = await complete(engine, reopened.id);
  assert.equal(linked.outcome, 'already-resolved'); assert.equal(linked.receipt.id, paid.receipt.id);
  assert.equal(calls.create, originalCalls.create);
});

test('latest review and earlier decisions survive restart and are included in the export', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'review.sqlite');
  const first = setup(t, path);
  const held = await complete(first.engine);
  const requested = await first.engine.review(held.id, input(held, 'request-evidence', 'The courier must supply the missing delivery photograph.'));
  const closed = await first.engine.review(held.id, input(requested, 'close-no-refund', 'The customer withdrew the request without a refund.'));
  first.store.close();
  const second = setup(t, path);
  assert.deepEqual(second.engine.getCase(held.id), closed);
  const packet = second.engine.exportCase(held.id);
  assert.deepEqual(packet.case.review, closed.review);
  assert.deepEqual(packet.case.events, closed.events); assert.equal(packet.operation, null);
  assert.deepEqual(packet.case.checks, held.checks); assert.deepEqual(packet.case.evidence, held.evidence);
});

test('HTTP review route returns the updated bare case and applies JSON and method controls', async t => {
  const { engine } = setup(t);
  const held = await complete(engine);
  const server = createApiServer({ engine });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/cases/${held.id}/review`;
  const request = (method, body, json = true) => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { Host: '127.0.0.1:4174', Origin: 'http://127.0.0.1:4173', ...(json ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request('GET')).status, 405);
  assert.equal((await request('POST', input(held, 'request-evidence'), false)).status, 415);
  const response = await request('POST', input(held, 'request-evidence'));
  assert.equal(response.status, 200); assert.equal(response.body.id, held.id);
  assert.equal(response.body.review.state, 'awaiting-evidence'); assert.equal(response.body.case, undefined);
  const stale = await request('POST', input(held, 'close-no-refund'));
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_revision');
});
