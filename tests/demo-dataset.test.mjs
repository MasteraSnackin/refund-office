import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createProviders } from '../server/providers.mjs';
import { createIntake } from '../server/intake.mjs';
import { startServer } from '../server/index.mjs';
import { validateDemoDataset, demoDatasetDigest, demoIntakePayloadHash } from '../server/demo-dataset.mjs';

function pack() {
  const order = { id: 'SYN-F12-O001', label: 'Synthetic order: one missing travel mug', totalMinor: 1500, currency: 'gbp', synthetic: true,
    delivery: { status: 'delivered', disputed: false, detail: 'Fictional packing record omits the travel mug.' },
    lines: [{ id: 'SYN-F12-L001', name: 'Travel mug', unitAmountMinor: 1500, ordered: 1, packed: 0 }] };
  const cases = Array.from({ length: 12 }, (_, index) => ({ id: `SYN-F12-C${index + 1}`, caseId: `RF-${2001 + index}`, title: `Synthetic case ${index + 1}`, shortTitle: 'Missing mug', orderId: order.id, complaint: 'The travel mug is missing from my parcel. Please refund that item.' }));
  return { schemaVersion: 1, id: 'focused-12', synthetic: true, title: 'Focused synthetic cases', merchant: { id: 'synthetic-shop', name: 'Fictional Test Shop', currency: 'gbp', synthetic: true },
    policy: { limitMinor: 2500, version: 1 }, orders: [order], cases, seedOperations: [],
    scenarios: cases.map(item => ({ caseId: item.id, category: 'missing-item', expectedOutcome: 'awaiting-approval', expectedAmountMinor: 1500 })) };
}
function history(dataset) {
  const order = dataset.orders[0]; const line = order.lines[0]; const id = 'seed-synthetic-remedy'; const idempotencyKey = 'refund-office-seed-synthetic-remedy'; const createdAt = '2026-10-01T12:00:00.000Z';
  return { id, orderId: order.id, lineId: line.id, issue: 'item_missing', amountMinor: 1500, status: 'succeeded', seeded: true, provider: 'local', idempotencyKey, createdAt,
    payload: { operationId: id, idempotencyKey, order: structuredClone(order), amountMinor: 1500, lineId: line.id, issue: 'item_missing' },
    receipt: { id: 'DEMO-SYNTHETIC-HISTORY', provider: 'local', amountMinor: 1500, currency: 'gbp', status: 'succeeded', createdAt, operationId: id, seeded: true } };
}
function isolatedPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-dataset-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'isolated.sqlite');
}
function open(t, options) {
  const store = createStore(options);
  t.after(() => { try { store.close(); } catch { /* Test may have closed it to reopen. */ } });
  return store;
}
async function waitUntil(check) {
  for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The isolated synthetic dataset did not finish local investigation.');
}

test('dataset validation accepts a bounded synthetic catalogue and returns an isolated copy with a stable digest', () => {
  const dataset = pack(); const checked = validateDemoDataset(dataset);
  assert.deepEqual(checked, dataset); checked.orders[0].label = 'Changed copied label'; assert.notEqual(checked.orders[0].label, dataset.orders[0].label);
  const reordered = { ...dataset, merchant: { synthetic: true, currency: 'gbp', name: dataset.merchant.name, id: dataset.merchant.id } };
  assert.equal(demoDatasetDigest(reordered), demoDatasetDigest(dataset));
  const withoutOptionalHistory = { ...dataset }; delete withoutOptionalHistory.seedOperations;
  assert.equal(demoDatasetDigest(withoutOptionalHistory), demoDatasetDigest(dataset));
});

test('dataset schema rejects runtime state, real-provider fields and invalid order arithmetic', () => {
  const mutations = [
    value => { value.synthetic = false; }, value => { value.merchant.synthetic = false; }, value => { value.id = 'arbitrary'; },
    value => { value.orders[0].synthetic = false; }, value => { value.orders[0].currency = 'usd'; },
    value => { value.orders[0].totalMinor++; }, value => { value.orders[0].lines[0].unitAmountMinor = 1.5; },
    value => { value.orders[0].lines[0].packed = 2; }, value => { value.orders[0].lines[0].ordered = 0; },
    value => { value.orders[0].paymentIntentId = 'pi_external'; }, value => { value.cases[0].approval = { state: 'approved' }; },
    value => { value.cases[0].status = 'complete'; }, value => { value.cases[0].events = []; }, value => { value.cases[0].receipt = {}; },
    value => { value.cases[0].orderId = 'unknown-order'; }, value => { value.cases[1].id = value.cases[0].id; },
    value => { value.cases[1].caseId = value.cases[0].caseId; }, value => { value.orders.push(structuredClone(value.orders[0])); },
    value => { value.orders[0].lines.push(structuredClone(value.orders[0].lines[0])); },
    value => { value.policy.version = 2; }, value => { value.cases.pop(); }, value => { value.scenarios.pop(); },
    value => { value.scenarios[0].expectedOutcome = 'refunded'; }, value => { value.scenarios[0].dependsOn = 'unrelated'; },
    value => { value.scenarios[0].dependsOn = value.cases[1].id; value.scenarios[1].dependsOn = value.cases[0].id; },
  ];
  for (const change of mutations) {
    const dataset = pack(); change(dataset);
    assert.throws(() => validateDemoDataset(dataset), error => error.code === 'invalid_demo_dataset');
  }
});

test('only exact explicitly seeded local history is accepted, with no fabricated human approval', () => {
  const dataset = pack(); dataset.seedOperations = [history(dataset)];
  assert.equal(validateDemoDataset(dataset).seedOperations[0].receipt.seeded, true);
  for (const change of [
    operation => { operation.seeded = false; }, operation => { operation.provider = 'stripe-sandbox'; }, operation => { operation.status = 'pending'; },
    operation => { operation.amountMinor = 100; }, operation => { operation.approval = { state: 'approved' }; },
    operation => { operation.receipt.id = 're_external'; }, operation => { operation.receipt.seeded = false; }, operation => { operation.receipt.amountMinor++; },
    operation => { operation.payload.order.totalMinor++; }, operation => { operation.receipt.paymentIntentId = 'pi_external'; },
    operation => { operation.submittedAt = operation.createdAt; },
  ]) {
    const changed = structuredClone(dataset); change(changed.seedOperations[0]);
    assert.throws(() => validateDemoDataset(changed), error => error.code === 'invalid_demo_dataset');
  }
});

test('pack preparation seeds only fresh cases and matching durable intake events, with no new operations', t => {
  const dataset = pack(); const store = open(t, { dbPath: ':memory:', dataset });
  const provider = createProviders({ env: {}, fetchImpl: () => assert.fail('Dataset preparation must stay offline.') });
  const engine = createEngine({ store, provider }); const intake = createIntake({ store, engine });
  assert.equal(store.cases().length, 12); assert.equal(store.intakeRequests().length, 12);
  assert.equal(store.getCase('missing-item'), null); assert.equal(store.operation('seed-remedy-106'), null);
  assert.ok(store.cases().every(item => item.status === 'ready' && item.stage === 'reception' && !item.approval && !item.receipt && item.intakeManaged));
  assert.ok(store.intakeRequests().every(item => item.status === 'queued'));
  assert.equal(store.operations(dataset.orders[0].id).length, 0);
  const seed = dataset.cases[0]; const eventId = `demo-${dataset.id}-${seed.id}`;
  const request = store.intakeByEvent(eventId);
  assert.equal(request.payloadHash, demoIntakePayloadHash(seed.orderId, seed.complaint));
  const replay = intake.submit({ eventId, orderId: seed.orderId, complaint: seed.complaint });
  assert.equal(replay.replayed, true); assert.equal(replay.case.id, seed.id); assert.equal(store.cases().length, 12);
  assert.equal(engine.bootstrap().demoDataset.caseCount, 12); assert.equal(engine.bootstrap().demoDataset.synthetic, true);
  assert.equal(engine.bootstrap().capabilities.networkMode, 'offline');
  assert.equal(engine.createCase({ orderId: seed.orderId, complaint: seed.complaint }).orderTotalMinor, 1500);
  assert.throws(() => engine.createCase({ orderId: 'DEMO-104', complaint: seed.complaint }), error => error.code === 'invalid_order');
});

test('reopening a marked database restores its persisted catalogue and does not reseed, overwrite decisions or duplicate events', t => {
  const dbPath = isolatedPath(t); const dataset = pack();
  const first = open(t, { dbPath, dataset });
  const requests = first.intakeRequests(); const cases = first.cases(); first.savePolicy({ limitMinor: 1200, version: 2 });
  first.close();
  const second = open(t, { dbPath });
  assert.deepEqual(second.orders(), dataset.orders); assert.deepEqual(second.cases(), cases); assert.deepEqual(second.intakeRequests(), requests);
  assert.deepEqual(second.policy(), { limitMinor: 1200, version: 2 }); assert.equal(second.demoDataset().digest, demoDatasetDigest(dataset));
  second.orders()[0].totalMinor = 1; assert.equal(second.orders()[0].totalMinor, 1500);
  second.close(); const third = open(t, { dbPath, dataset }); assert.equal(third.cases().length, 12); assert.deepEqual(third.policy(), { limitMinor: 1200, version: 2 });
});

test('dataset import refuses an existing ordinary database and preserves its records', t => {
  const dbPath = isolatedPath(t); const first = open(t, { dbPath }); const before = { cases: first.cases(), policy: first.policy(), operations: first.operations('DEMO-106') }; first.close();
  assert.throws(() => createStore({ dbPath, dataset: pack() }), /nonempty unmarked database/);
  const after = open(t, { dbPath }); assert.deepEqual(after.cases(), before.cases); assert.deepEqual(after.policy(), before.policy); assert.deepEqual(after.operations('DEMO-106'), before.operations);
  assert.equal(after.demoDataset(), null); assert.equal(createEngine({ store: after, provider: createProviders({ env: {} }) }).bootstrap().demoDataset, undefined);
});

test('a marked database rejects a different digest and detects a corrupt saved catalogue', t => {
  const dbPath = isolatedPath(t); const dataset = pack(); const first = open(t, { dbPath, dataset }); const originalCases = first.cases(); first.close();
  const changed = structuredClone(dataset); changed.title = 'Another synthetic title';
  assert.throws(() => createStore({ dbPath, dataset: changed }), /different dataset digest/);
  const second = open(t, { dbPath }); assert.deepEqual(second.cases(), originalCases);
  const marker = JSON.parse(second.db.prepare("SELECT data FROM settings WHERE key='demoDataset'").get().data); marker.dataset.title = 'Tampered catalogue';
  second.db.prepare("UPDATE settings SET data=? WHERE key='demoDataset'").run(JSON.stringify(marker)); second.close();
  assert.throws(() => createStore({ dbPath }), /integrity check/);
});

test('catalogue-backed background work stops every fresh claim for approval and leaves unrelated databases unchanged', async t => {
  const dataset = pack(); const store = open(t, { dbPath: ':memory:', dataset }); const ordinary = open(t, { dbPath: ':memory:' }); const unrelated = ordinary.cases();
  const calls = { create: 0, retrieve: 0 }; const local = createProviders({ env: {} });
  const provider = { ...local, createRefund: async input => { calls.create++; return local.createRefund(input); }, retrieveRefund: async () => { calls.retrieve++; assert.fail('Intake cannot reconcile.'); } };
  const engine = createEngine({ store, provider }); const intake = createIntake({ store, engine, stepDelayMs: 1 }); t.after(() => intake.close()); intake.start();
  await waitUntil(() => store.intakeRequests().every(request => request.status === 'awaiting-review'));
  assert.ok(store.cases().every(item => item.outcome === 'awaiting-approval' && item.approval.state === 'required' && !item.operationId));
  assert.equal(store.operations(dataset.orders[0].id).length, 0); assert.deepEqual(calls, { create: 0, retrieve: 0 }); assert.deepEqual(ordinary.cases(), unrelated);
  const item = engine.getCase(dataset.cases[0].id);
  const approved = await engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'I reviewed this synthetic order and approve this exact local refund.' });
  const paid = await engine.advance(approved.id, { expectedRevision: approved.revision });
  assert.equal(paid.outcome, 'refunded'); assert.equal(paid.receipt.amountMinor, 1500); assert.equal(calls.create, 1);
});

test('explicit historical remedies stay visibly seeded and cannot be mistaken for a fresh approved refund', async t => {
  const dataset = pack(); dataset.seedOperations = [history(dataset)];
  const store = open(t, { dbPath: ':memory:', dataset }); const engine = createEngine({ store, provider: createProviders({ env: {} }) });
  const item = dataset.cases[0]; let current = await engine.run(item.id);
  while (current.status === 'running') current = await engine.advance(current.id, { expectedRevision: current.revision });
  assert.equal(current.outcome, 'already-resolved'); assert.equal(current.receipt.seeded, true); assert.equal(current.approval, null);
  assert.equal(store.operations(item.orderId).length, 1); assert.equal(store.operation(current.operationId).approval, undefined);
  assert.equal(engine.exportCase(current.id).operation.seeded, true);
});


test('expected launch identity rejects ordinary databases without changing existing database bytes', async t => {
  const dbPath = isolatedPath(t); const first = open(t, { dbPath });
  const engine = createEngine({ store: first, provider: createProviders({ env: {} }) });
  await engine.run('missing-item'); first.close();
  const before = readFileSync(dbPath); const dataset = pack();
  assert.throws(() => createStore({ dbPath, expectedDatasetId: dataset.id, expectedDatasetDigest: demoDatasetDigest(dataset) }), /not a marked demo pack/);
  assert.deepEqual(readFileSync(dbPath), before);
});

test('expected launch identity rejects missing, incomplete, wrong and corrupted packs before recovery', async t => {
  const dbPath = isolatedPath(t); const dataset = pack(); const digest = demoDatasetDigest(dataset);
  const expected = { expectedDatasetId: dataset.id, expectedDatasetDigest: digest };
  assert.throws(() => createStore({ dbPath, ...expected }), /database is missing/); assert.equal(existsSync(dbPath), false);
  assert.throws(() => createStore({ dbPath, expectedDatasetId: dataset.id }), /exact expected pack/); assert.equal(existsSync(dbPath), false);
  assert.throws(() => createStore({ dbPath: ':memory:', ...expected }), /database is missing/);
  const first = open(t, { dbPath, dataset }); const engine = createEngine({ store: first, provider: createProviders({ env: {} }) });
  await engine.advanceIntake(dataset.cases[0].id, first.getCase(dataset.cases[0].id).intakeRequestId);
  first.close(); const before = readFileSync(dbPath);
  for (const wrong of [{ expectedDatasetId: 'busy-50', expectedDatasetDigest: digest }, { expectedDatasetId: dataset.id, expectedDatasetDigest: '0'.repeat(64) }]) {
    assert.throws(() => createStore({ dbPath, ...wrong }), /does not match the expected demo pack/);
    assert.deepEqual(readFileSync(dbPath), before);
  }
  const correct = open(t, { dbPath, ...expected });
  assert.equal(correct.demoDataset().digest, digest); assert.equal(correct.cases().length, 12);
  const marker = JSON.parse(correct.db.prepare("SELECT data FROM settings WHERE key='demoDataset'").get().data);
  marker.dataset.title = 'Changed without updating its stored digest';
  correct.db.prepare("UPDATE settings SET data=? WHERE key='demoDataset'").run(JSON.stringify(marker)); correct.close();
  const corruptedBytes = readFileSync(dbPath);
  assert.throws(() => createStore({ dbPath, ...expected }), /integrity check/);
  assert.deepEqual(readFileSync(dbPath), corruptedBytes);
});


test('server startup forwards expected pack identity from the environment before opening a listener', t => {
  const dbPath = isolatedPath(t); const ordinary = open(t, { dbPath }); ordinary.close();
  const before = readFileSync(dbPath); const dataset = pack();
  const previousId = process.env.REFUND_OFFICE_DEMO_PACK; const previousDigest = process.env.REFUND_OFFICE_DEMO_DIGEST;
  try {
    process.env.REFUND_OFFICE_DEMO_PACK = dataset.id; process.env.REFUND_OFFICE_DEMO_DIGEST = demoDatasetDigest(dataset);
    assert.throws(() => startServer({ port: 4174, dbPath, provider: createProviders({ env: {} }) }), /not a marked demo pack/);
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    if (previousId === undefined) delete process.env.REFUND_OFFICE_DEMO_PACK; else process.env.REFUND_OFFICE_DEMO_PACK = previousId;
    if (previousDigest === undefined) delete process.env.REFUND_OFFICE_DEMO_DIGEST; else process.env.REFUND_OFFICE_DEMO_DIGEST = previousDigest;
  }
});
