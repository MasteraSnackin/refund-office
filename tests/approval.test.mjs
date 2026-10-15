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
import { ORDERS } from '../server/fixtures.mjs';

function setup(t, dbPath = ':memory:') {
  const store = createStore({ dbPath });
  const local = createProviders({ env: {} });
  const calls = { create: 0, retrieve: 0 };
  const provider = { ...local,
    createRefund: async value => { calls.create++; return local.createRefund(value); },
    retrieveRefund: async value => { calls.retrieve++; return local.retrieveRefund(value); },
  };
  const engine = createEngine({ store, provider });
  t.after(() => { try { store.close(); } catch { /* Restart test already closed it. */ } });
  return { store, local, provider, engine, calls };
}
const approvalInput = item => ({ expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I have checked the evidence and approve this exact local refund.' });
const advance = (engine, item) => engine.advance(item.id, { expectedRevision: item.revision });
async function investigate(engine, id = 'missing-item') {
  let item = await engine.run(id);
  for (let step = 0; item.status === 'running' && step < 8; step++) item = await advance(engine, item);
  return item;
}
async function prepare(engine, id = 'missing-item') {
  const item = await investigate(engine, id);
  assert.equal(item.outcome, 'awaiting-approval');
  return engine.approve(item.id, approvalInput(item));
}
function stripApproval(store, item, { status = 'reserved', submitted = false, receipt = null } = {}) {
  const operation = store.operation(item.operationId);
  delete operation.approval; delete operation.approvalSnapshot;
  operation.status = status; operation.receipt = receipt;
  if (submitted) operation.submittedAt = new Date().toISOString();
  else delete operation.submittedAt;
  store.saveOperation(operation);
  const legacy = { ...item, approval: null, ...(status === 'pending' ? { status: 'pending', outcome: 'pending' } : {}), receipt };
  store.saveCase(legacy);
  return { item: legacy, operation };
}

test('every fresh eligible refund stops for human approval before reserving or calling payments', async t => {
  const { engine, store, calls } = setup(t);
  const item = await investigate(engine);
  assert.equal(item.status, 'review'); assert.equal(item.stage, 'review'); assert.equal(item.outcome, 'awaiting-approval');
  assert.equal(item.approval.state, 'required'); assert.match(item.approval.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(item.approval.amountMinor, 2000); assert.equal(item.approval.provider, 'local');
  assert.equal(item.approval.orderId, 'DEMO-104'); assert.equal(item.approval.lineId, '104-3');
  assert.equal(item.operationId, undefined); assert.equal(item.receipt, null);
  assert.equal(store.operations(item.orderId).length, 0); assert.deepEqual(calls, { create: 0, retrieve: 0 });
  assert.ok(item.checks.every(check => check.status === 'pass'));
  await assert.rejects(advance(engine, item), error => error.code === 'case_not_running');
  await assert.rejects(engine.resume(item.id), error => error.code === 'case_not_paused');
  await assert.rejects(engine.reconcile(item.id), error => error.code === 'nothing_to_reconcile');
  const repeated = await investigate(engine);
  assert.equal(repeated.outcome, 'awaiting-approval'); assert.equal(store.operations(item.orderId).length, 0);
});

test('explicit approval is atomically bound to the exact operation and exported before submission', async t => {
  const { engine, store, provider, local, calls } = setup(t);
  const required = await investigate(engine);
  const approved = await engine.approve(required.id, { ...approvalInput(required), actor: 'forged-actor' });
  assert.equal(approved.status, 'running'); assert.equal(approved.stage, 'payments');
  assert.equal(approved.approval.state, 'approved'); assert.equal(approved.approval.actor, 'local-reviewer');
  assert.equal(approved.approval.operationId, approved.operationId); assert.ok(approved.approval.decidedAt);
  const operation = store.operation(approved.operationId);
  assert.equal(operation.status, 'reserved'); assert.equal(operation.submittedAt, undefined);
  assert.deepEqual(operation.approval, approved.approval); assert.equal(calls.create, 0);
  assert.equal(operation.approvalSnapshot.caseId, approved.id);
  assert.deepEqual(operation.approvalSnapshot.evidence, required.evidence);
  provider.createRefund = async payload => {
    calls.create++;
    const saved = store.operation(payload.operationId);
    assert.equal(saved.approval.state, 'approved'); assert.deepEqual(saved.payload, payload);
    assert.equal(saved.approval.operationId, saved.id);
    return local.createRefund(payload);
  };
  const done = await advance(engine, approved);
  assert.equal(done.outcome, 'refunded'); assert.equal(calls.create, 1);
  const packet = engine.exportCase(done.id);
  assert.deepEqual(packet.operation.approval, approved.approval);
  assert.deepEqual(packet.operation.approvalSnapshot, operation.approvalSnapshot);
  assert.ok(packet.case.events.some(event => event.approval?.fingerprint === required.approval.fingerprint));
});

test('invalid amount, fingerprint, reason or revision cannot grant approval', async t => {
  const { engine, store, calls } = setup(t);
  const item = await investigate(engine);
  const valid = approvalInput(item);
  for (const patch of [{ expectedAmountMinor: 1.5 }, { expectedAmountMinor: 0 }, { expectedRevision: -1 }, { expectedRevision: '3' }, { fingerprint: '' }, { note: 'short' }, { note: 'x'.repeat(1001) }]) await assert.rejects(engine.approve(item.id, { ...valid, ...patch }), error => error.status === 400);
  for (const patch of [{ expectedAmountMinor: 1900 }, { fingerprint: '0'.repeat(64) }, { expectedRevision: item.revision - 1 }]) await assert.rejects(engine.approve(item.id, { ...valid, ...patch }), error => error.status === 409);
  assert.deepEqual(engine.getCase(item.id), item); assert.equal(store.operations(item.orderId).length, 0);
  assert.deepEqual(calls, { create: 0, retrieve: 0 });
});

test('a changed policy invalidates a request even if the amount remains within its limit', async t => {
  const { engine, store } = setup(t);
  const item = await investigate(engine);
  engine.updatePolicy({ limitMinor: 3000 });
  await assert.rejects(engine.approve(item.id, approvalInput(item)), error => error.code === 'approval_changed');
  const invalid = engine.getCase(item.id);
  assert.equal(invalid.status, 'review'); assert.equal(invalid.outcome, 'held'); assert.equal(invalid.approval.state, 'invalidated');
  assert.equal(store.operations(item.orderId).length, 0);
  const fresh = await investigate(engine);
  assert.notEqual(fresh.approval.fingerprint, item.approval.fingerprint); assert.equal(fresh.approval.policyVersion, 2);
});

test('human approval cannot override the refund policy limit', async t => {
  const { engine, store } = setup(t);
  const item = await investigate(engine);
  engine.updatePolicy({ limitMinor: 1000 });
  await assert.rejects(engine.approve(item.id, approvalInput(item)), error => error.code === 'approval_changed');
  const held = await investigate(engine);
  assert.equal(held.outcome, 'held'); assert.equal(held.approval, null);
  await assert.rejects(engine.approve(held.id, { ...approvalInput(item), expectedRevision: held.revision }), error => error.code === 'approval_not_required');
  assert.equal(store.operations(item.orderId).length, 0);
});

test('changes to complaint, proposal, displayed amount, evidence, order or provider invalidate an approval request', async t => {
  for (const field of ['complaint', 'proposal', 'displayed-amount', 'evidence', 'order', 'provider']) {
    const { engine, store, provider, calls } = setup(t);
    const item = await investigate(engine);
    const changed = structuredClone(item);
    const order = ORDERS.find(order => order.id === item.orderId);
    const originalName = order.lines[2].name;
    try {
      if (field === 'complaint') changed.complaint += ' Changed request.';
      if (field === 'proposal') changed.proposal.amountMinor = 1000;
      if (field === 'displayed-amount') changed.proposedAmountMinor = 1000;
      if (field === 'evidence') changed.evidence[0].body += ' Corrected record.';
      if (field === 'order') order.lines[2].name = 'Changed item name';
      if (field === 'provider') provider.capabilities = () => ({ analyser: 'local', payments: 'stripe-sandbox', modelConfigured: false, stripeConfigured: true });
      store.saveCase(changed);
      await assert.rejects(engine.approve(item.id, approvalInput(item)), error => error.code === 'approval_changed', field);
      assert.equal(engine.getCase(item.id).approval.state, 'invalidated');
      assert.equal(store.operations(item.orderId).length, 0); assert.deepEqual(calls, { create: 0, retrieve: 0 });
    } finally { order.lines[2].name = originalName; }
  }
});

test('an inconsistent saved approval amount cannot approve a different proposal amount', async t => {
  const { engine, store, calls } = setup(t);
  const item = await investigate(engine);
  item.approval.amountMinor = 1000;
  store.saveCase(item);
  await assert.rejects(engine.approve(item.id, approvalInput(item)), error => error.code === 'approval_changed');
  assert.equal(store.operations(item.orderId).length, 0); assert.equal(calls.create, 0);
  assert.equal(engine.getCase(item.id).approval.state, 'invalidated');
});

test('submission rechecks approved facts and policy without deleting the reserved operation', async t => {
  for (const field of ['policy', 'evidence', 'proposal', 'provider', 'payload']) {
    const { engine, store, provider, calls } = setup(t);
    const approved = await prepare(engine);
    const changed = structuredClone(approved);
    if (field === 'policy') engine.updatePolicy({ limitMinor: 3000 });
    if (field === 'evidence') changed.evidence[0].body += ' Changed after approval.';
    if (field === 'proposal') changed.proposal.reason += ' Changed after approval.';
    if (field === 'provider') provider.capabilities = () => ({ analyser: 'local', payments: 'stripe-sandbox', modelConfigured: false, stripeConfigured: true });
    if (field === 'payload') {
      const operation = store.operation(approved.operationId); operation.payload.amountMinor = 1000; store.saveOperation(operation);
    }
    store.saveCase(changed);
    const stopped = await advance(engine, changed);
    assert.equal(stopped.status, 'review', field); assert.equal(stopped.approval.state, 'invalidated', field);
    assert.equal(store.operation(approved.operationId).submittedAt, undefined);
    assert.equal(store.operation(approved.operationId).status, 'reserved');
    assert.deepEqual(calls, { create: 0, retrieve: 0 });
  }
});

test('remaining balance is rechecked at approval even when the saved fingerprint is unchanged', async t => {
  const { engine, store, calls } = setup(t);
  const item = await investigate(engine);
  store.saveOperation({ id: 'other-remedy', orderId: item.orderId, lineId: '104-1', issue: 'other-recorded-remedy', amountMinor: 5000, status: 'succeeded', receipt: null });
  await assert.rejects(engine.approve(item.id, approvalInput(item)), error => error.code === 'approval_changed');
  assert.equal(engine.getCase(item.id).approval.state, 'invalidated');
  assert.equal(store.operations(item.orderId).length, 1); assert.equal(calls.create, 0);
});

test('concurrent approval clicks record only one approval and operation', async t => {
  const { engine, store } = setup(t);
  const item = await investigate(engine);
  const results = await Promise.allSettled([engine.approve(item.id, approvalInput(item)), engine.approve(item.id, approvalInput(item))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'stale_revision');
  assert.equal(store.operations(item.orderId).length, 1);
  assert.equal(engine.getCase(item.id).events.filter(event => event.label === 'Human approval recorded').length, 1);
});

test('concurrent approvals for duplicate cases share one operation rather than authorising a second refund', async t => {
  const { engine, store, calls } = setup(t);
  const other = engine.createCase({ orderId: 'DEMO-104', complaint: 'The travel mug is missing. Please refund the missing item.' });
  const [a, b] = await Promise.all([investigate(engine), investigate(engine, other.id)]);
  const [approved, linked] = await Promise.all([engine.approve(a.id, approvalInput(a)), engine.approve(b.id, approvalInput(b))]);
  assert.equal(approved.stage, 'payments'); assert.equal(approved.status, 'running');
  assert.equal(linked.status, 'pending'); assert.equal(linked.approval.state, 'invalidated');
  assert.equal(approved.operationId, linked.operationId); assert.equal(store.operations(a.orderId).length, 1);
  assert.equal(calls.create, 0);
  const paid = await advance(engine, approved);
  const reconciled = await engine.reconcile(linked.id);
  assert.equal(reconciled.receipt.id, paid.receipt.id); assert.equal(calls.create, 1);
});

test('requesting evidence or closing invalidates the outstanding approval request', async t => {
  for (const action of ['request-evidence', 'close-no-refund']) {
    const { engine, store, calls } = setup(t);
    const item = await investigate(engine);
    const reviewed = await engine.review(item.id, { action, expectedRevision: item.revision, note: 'Further review is required before any refund decision.' });
    assert.equal(reviewed.approval.state, 'invalidated');
    await assert.rejects(engine.approve(item.id, { ...approvalInput(item), expectedRevision: reviewed.revision }), error => error.code === 'approval_not_required');
    assert.equal(store.operations(item.orderId).length, 0); assert.equal(calls.create, 0);
  }
});

test('legacy reserved operations cannot bypass approval through advance or resume and can be explicitly approved', async t => {
  for (const action of ['advance', 'resume']) {
    const { engine, store, calls } = setup(t);
    const prepared = await prepare(engine);
    const legacy = stripApproval(store, prepared);
    if (action === 'resume') { legacy.item.status = 'paused'; store.saveCase(legacy.item); }
    const stopped = action === 'advance' ? await advance(engine, legacy.item) : await engine.resume(legacy.item.id);
    assert.equal(stopped.status, 'review'); assert.match(stopped.summary, /Human approval is required/);
    assert.equal(calls.create, 0); assert.deepEqual(store.operation(prepared.operationId), legacy.operation);
    const required = await investigate(engine, stopped.id);
    assert.equal(required.outcome, 'awaiting-approval'); assert.equal(required.approval.state, 'required');
    assert.equal(required.operationId, prepared.operationId);
    const approved = await engine.approve(required.id, approvalInput(required));
    assert.equal(approved.operationId, prepared.operationId);
    assert.deepEqual(store.operation(prepared.operationId).payload, legacy.operation.payload);
    assert.equal((await advance(engine, approved)).outcome, 'refunded'); assert.equal(calls.create, 1);
  }
});

test('legacy pending operations without a receipt never call the provider fallback without original approval', async t => {
  const { engine, store, calls } = setup(t);
  const prepared = await prepare(engine);
  const legacy = stripApproval(store, prepared, { status: 'pending', submitted: true });
  const result = await engine.reconcile(legacy.item.id);
  assert.equal(result.status, 'pending'); assert.equal(result.receipt, null);
  assert.match(result.summary, /cannot be resubmitted/); assert.deepEqual(calls, { create: 0, retrieve: 0 });
  assert.deepEqual(store.operation(prepared.operationId), legacy.operation);
  await assert.rejects(engine.run(result.id), error => error.status === 409);
  const running = { ...result, status: 'running' }; store.saveCase(running);
  assert.equal((await advance(engine, running)).status, 'pending');
  assert.deepEqual(calls, { create: 0, retrieve: 0 });
});

test('legacy known receipts can be read back without inventing an approval', async t => {
  const { engine, store, provider, local, calls } = setup(t);
  const prepared = await prepare(engine);
  const savedOperation = store.operation(prepared.operationId);
  const known = await local.createRefund(savedOperation.payload);
  const legacy = stripApproval(store, prepared, { status: 'pending', submitted: true, receipt: { ...known, status: 'pending' } });
  provider.retrieveRefund = async ({ receipt }) => { calls.retrieve++; assert.equal(receipt.id, known.id); return known; };
  const result = await engine.reconcile(legacy.item.id);
  assert.equal(result.outcome, 'refunded'); assert.equal(result.receipt.id, known.id);
  assert.equal(result.approval, null); assert.equal(store.operation(prepared.operationId).approval, undefined);
  assert.deepEqual(calls, { create: 0, retrieve: 1 });
  const repeated = await investigate(engine, result.id);
  assert.equal(repeated.outcome, 'already-resolved'); assert.equal(repeated.approval, null);
});

test('approved uncertain submissions reconcile the immutable original approval from an alias case after policy changes', async t => {
  const { engine, store, provider, local, calls } = setup(t);
  const prepared = await prepare(engine);
  const originalOperation = store.operation(prepared.operationId);
  provider.createRefund = async () => { calls.create++; throw new ProviderError('timeout', 'No confirmed response.', { retryable: true }); };
  const pending = await advance(engine, prepared);
  assert.equal(pending.status, 'pending'); assert.equal(pending.receipt, null);
  const other = engine.createCase({ orderId: pending.orderId, complaint: 'The travel mug is missing. Please refund the item.' });
  const alias = await investigate(engine, other.id);
  assert.equal(alias.status, 'pending');
  engine.updatePolicy({ limitMinor: 100 });
  provider.retrieveRefund = async ({ receipt, operation }) => {
    calls.retrieve++; assert.equal(receipt, null);
    assert.deepEqual(operation.payload, originalOperation.payload);
    assert.deepEqual(operation.approval, originalOperation.approval);
    return local.createRefund(operation.payload);
  };
  const done = await engine.reconcile(alias.id);
  assert.equal(done.outcome, 'refunded'); assert.equal(done.operationId, prepared.operationId);
  assert.deepEqual(calls, { create: 1, retrieve: 1 }); assert.equal(store.operations(pending.orderId).length, 1);
});

test('required and approved requests survive restart without granting approval automatically', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-approval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'approval.sqlite');
  const first = setup(t, path);
  const required = await investigate(first.engine);
  first.store.close();
  const second = setup(t, path);
  assert.deepEqual(second.engine.getCase(required.id), required);
  assert.equal(second.store.operations(required.orderId).length, 0);
  const approved = await second.engine.approve(required.id, approvalInput(required));
  second.store.close();
  const third = setup(t, path);
  const recovered = third.engine.getCase(required.id);
  assert.equal(recovered.status, 'paused'); assert.deepEqual(recovered.approval, approved.approval);
  const resumed = await third.engine.resume(recovered.id);
  assert.equal((await advance(third.engine, resumed)).outcome, 'refunded');
  assert.equal(third.calls.create, 1);
});

test('HTTP approve route returns a bare case and refuses a stale approval retry', async t => {
  const { engine } = setup(t);
  const required = await investigate(engine);
  const server = createApiServer({ engine });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/cases/${required.id}/approve`;
  const send = body => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { Host: '127.0.0.1:4174', 'Content-Type': 'application/json' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const response = await send(approvalInput(required));
  assert.equal(response.status, 200); assert.equal(response.body.id, required.id); assert.equal(response.body.approval.state, 'approved');
  const repeated = await send(approvalInput(required));
  assert.equal(repeated.status, 409); assert.equal(repeated.body.error.code, 'stale_revision');
});
