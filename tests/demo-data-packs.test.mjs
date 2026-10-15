import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDemoDataset, intakePayloads, outcomeCsv } from '../scripts/generate-demo-data.mjs';
import { validateDemoDataset } from '../server/demo-dataset.mjs';
import { createStore } from '../server/store.mjs';
import { createProviders } from '../server/providers.mjs';
import { createEngine } from '../server/engine.mjs';
import { createIntake } from '../server/intake.mjs';

const ids = ['focused-12', 'busy-50'];
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

async function investigate(engine, id) {
  let item = engine.getCase(id);
  for (let step = 0; ['ready', 'running'].includes(item.status) && step < 8; step++) item = await engine.advanceIntake(id, item.intakeRequestId);
  assert.equal(['ready', 'running'].includes(item.status), false, `${id} must reach a bounded human-review or historical outcome`);
  return item;
}

test('both committed packs are reproducible, synthetic and arithmetically coherent', () => {
  for (const id of ids) {
    const generated = buildDemoDataset(id);
    assert.equal(read(`demo-data/${id}.json`), JSON.stringify(generated, null, 2) + '\n');
    const dataset = validateDemoDataset(generated);
    assert.equal(dataset.cases.length, id === 'focused-12' ? 12 : 50);
    assert.equal(dataset.orders.length, id === 'focused-12' ? 11 : 46);
    assert.equal(dataset.seedOperations.length, id === 'focused-12' ? 1 : 4);
    assert.equal(dataset.synthetic, true);
    assert.equal(dataset.merchant.synthetic, true);
    for (const order of dataset.orders) {
      assert.equal(order.synthetic, true);
      assert.equal(order.currency, 'gbp');
      assert.equal(order.totalMinor, order.lines.reduce((sum, line) => sum + line.unitAmountMinor * line.ordered, 0));
      assert.ok(order.lines.every(line => line.packed >= 0 && line.packed <= line.ordered));
    }
    for (const item of dataset.cases) assert.deepEqual(Object.keys(item).sort(), ['caseId', 'complaint', 'id', 'orderId', 'shortTitle', 'title']);
    for (const operation of dataset.seedOperations) {
      assert.equal(operation.provider, 'local');
      assert.equal(operation.seeded, true);
      assert.equal(operation.receipt.seeded, true);
      assert.match(operation.receipt.id, /^DEMO-HISTORY-/);
      assert.equal(operation.receipt.provider, 'local');
    }
    assert.doesNotMatch(JSON.stringify(dataset), /(?:sk|rk)_(?:test|live)_|"(?:email|customerEmail|paymentIntentId|apiKey|accessToken)"/);
  }
});

test('expected CSV and stable n8n examples describe the same saved cases', () => {
  assert.equal(read('demo-data/expected-outcomes.csv'), outcomeCsv(ids.map(buildDemoDataset)));
  for (const id of ids) {
    const dataset = buildDemoDataset(id);
    const examples = intakePayloads(dataset);
    assert.equal(read(`demo-data/n8n-intake.${id}.json`), JSON.stringify(examples, null, 2) + '\n');
    assert.equal(new Set(examples.map(item => item.eventId)).size, dataset.cases.length);
    examples.forEach((event, index) => {
      assert.equal(event.eventId, `demo-${id}-${dataset.cases[index].id}`);
      assert.equal(event.orderId, dataset.cases[index].orderId);
      assert.equal(event.complaint, dataset.cases[index].complaint);
    });
  }
});

for (const id of ids) test(`${id}: every expected initial outcome matches the real local engine without a new payment`, async t => {
  const dataset = buildDemoDataset(id);
  const store = createStore({ dbPath: ':memory:', dataset });
  t.after(() => store.close());
  const local = createProviders({ env: {}, fetchImpl: async () => { throw new Error('No external request is permitted.'); } });
  let paymentCalls = 0;
  const engine = createEngine({ store, provider: { ...local, createRefund: async () => { paymentCalls++; throw new Error('Investigation must not submit a refund.'); } } });
  assert.ok(store.cases().every(item => item.status === 'ready' && !item.approval && !item.receipt));
  const outcomes = {};
  for (const expected of dataset.scenarios) {
    const item = await investigate(engine, expected.caseId);
    assert.equal(item.outcome, expected.expectedOutcome, expected.caseId);
    assert.equal(item.proposedAmountMinor, expected.expectedAmountMinor, expected.caseId);
    outcomes[item.outcome] = (outcomes[item.outcome] || 0) + 1;
    if (item.outcome === 'awaiting-approval') {
      assert.equal(item.status, 'review');
      assert.equal(item.approval.state, 'required');
      assert.equal(item.receipt, null);
      assert.equal(item.operationId, undefined);
    } else if (item.outcome === 'held') {
      assert.equal(item.status, 'review');
      assert.equal(item.receipt, null);
    } else assert.equal(item.receipt.seeded, true);
  }
  assert.deepEqual(outcomes, id === 'focused-12' ? { 'awaiting-approval': 6, held: 5, 'already-resolved': 1 } : { 'awaiting-approval': 26, held: 20, 'already-resolved': 4 });
  assert.equal(paymentCalls, 0);
  assert.equal(store.orders().reduce((count, order) => count + store.operations(order.id).length, 0), dataset.seedOperations.length);
});

test('prepared n8n events replay seeded intake without creating extra cases', t => {
  for (const id of ids) {
    const dataset = buildDemoDataset(id);
    const store = createStore({ dbPath: ':memory:', dataset });
    t.after(() => store.close());
    const engine = createEngine({ store, provider: createProviders({ env: {} }) });
    const intake = createIntake({ store, engine });
    for (const [index, event] of intakePayloads(dataset).entries()) {
      const result = intake.submit(event);
      assert.equal(result.replayed, true);
      assert.equal(result.case.id, dataset.cases[index].id);
    }
    assert.equal(store.cases().length, dataset.cases.length);
    assert.equal(store.intakeRequests().length, dataset.cases.length);
  }
});

test('duplicate demonstrations require a human decision before a rerun finds one shared remedy', async t => {
  for (const id of ids) {
    const dataset = buildDemoDataset(id);
    const store = createStore({ dbPath: ':memory:', dataset });
    t.after(() => store.close());
    const local = createProviders({ env: {} });
    let payments = 0;
    const engine = createEngine({ store, provider: { ...local, createRefund: async payload => { payments++; return local.createRefund(payload); } } });
    const pairs = dataset.scenarios.filter(item => item.dependsOn);
    for (const repeat of pairs) {
      let original = await investigate(engine, repeat.dependsOn);
      const duplicate = await investigate(engine, repeat.caseId);
      assert.equal(original.outcome, 'awaiting-approval');
      assert.equal(duplicate.outcome, 'awaiting-approval');
      assert.equal(store.operations(original.orderId).length, 0);
      original = await engine.approve(original.id, { expectedRevision: original.revision, expectedAmountMinor: original.approval.amountMinor, fingerprint: original.approval.fingerprint, note: 'Synthetic test: I inspected the matching packing record and approve this exact local refund.' });
      for (let step = 0; original.status === 'running' && step < 5; step++) original = await engine.advance(original.id, { expectedRevision: original.revision });
      assert.equal(original.outcome, 'refunded');
      await engine.run(duplicate.id);
      const repeated = await investigate(engine, duplicate.id);
      assert.equal(repeated.outcome, 'already-resolved');
      assert.equal(repeated.receipt.id, original.receipt.id);
      assert.equal(store.operations(original.orderId).length, 1);
    }
    assert.equal(payments, pairs.length);
  }
});
