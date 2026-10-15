import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_AT = '2026-10-01T09:00:00.000Z';
const GBP = value => `£${(value / 100).toFixed(2)}`;
const pad = value => String(value).padStart(3, '0');
const PRODUCT = {
  1: 'Travel mug', 2: 'Pencil pack', 3: 'Drawing board', 4: 'Desk lamp',
  5: 'Notebook set', 6: 'Cable pouch', 7: 'Desk organiser', 8: 'Sketchbook',
  9: 'Travel pouch', 10: 'Desk mat', 11: 'Desk mat', 12: 'Pen set',
};

export function buildDemoDataset(id) {
  if (!['focused-12', 'busy-50'].includes(id)) throw new Error('Choose focused-12 or busy-50.');
  const count = id === 'focused-12' ? 12 : 50;
  const prefix = count === 12 ? 'SYN-F12' : 'SYN-B50';
  const caseBase = count === 12 ? 2000 : 2100;
  const orders = [], cases = [], seedOperations = [], scenarios = [];
  for (let index = 1; index <= count; index++) {
    const kind = (index - 1) % 12 + 1;
    const batch = Math.floor((index - 1) / 12);
    const caseId = `${prefix}-C${pad(index)}`;
    const label = `RF-${caseBase + index}`;
    const orderNumber = kind === 11 ? index - 1 : index;
    const orderId = `${prefix}-O${pad(orderNumber)}`;
    const name = PRODUCT[kind];
    let unit = ({ 1: [2000, 1450, 1000, 1800, 1250][batch], 2: [750, 900, 1100, 600, 800][batch], 3: 2500, 4: 2501, 5: 1500, 6: 1200, 7: 1500, 8: 1000, 9: 1200 + batch * 50, 10: 1800 - batch * 200, 11: 1800 - batch * 200, 12: 850 + batch * 100 })[kind];
    const ordered = kind === 2 ? 3 : 1;
    const packed = [5, 6, 7].includes(kind) ? 1 : kind === 2 ? 1 : 0;
    let title, shortTitle, complaint, category, expectedOutcome = 'awaiting-approval', expectedAmountMinor = (ordered - packed) * unit;
    if (kind === 1) { title = 'Travel mug omitted'; shortTitle = 'Missing mug'; complaint = 'My parcel arrived, but the travel mug is missing. Please refund the missing travel mug.'; category = 'eligible-missing-item'; }
    if (kind === 2) { title = 'Two pencil packs omitted'; shortTitle = 'Two units missing'; complaint = 'The pencil pack is missing from my order; two units were not supplied. Please check the packing record.'; category = 'quantity-two-missing'; }
    if (kind === 3) { title = 'Exactly at the policy limit'; shortTitle = 'At £25 limit'; complaint = 'The drawing board is missing. Please refund the drawing board that was not supplied.'; category = 'exact-policy-limit'; }
    if (kind === 4) { title = 'One penny above the limit'; shortTitle = 'Above £25 limit'; complaint = 'The desk lamp is missing. Please refund the missing desk lamp.'; category = 'over-policy-limit'; expectedOutcome = 'held'; }
    if (kind === 5) { title = 'Delivery evidence conflicts'; shortTitle = 'Delivery disputed'; complaint = 'The tracking says delivered, but I have not received my parcel. Please investigate.'; category = 'disputed-delivery'; expectedOutcome = 'held'; expectedAmountMinor = 0; }
    if (kind === 6) { title = 'Claim conflicts with packing'; shortTitle = 'All items packed'; complaint = 'The cable pouch is missing. Please check the packing record and refund it.'; category = 'all-packed-unsupported'; expectedOutcome = 'held'; expectedAmountMinor = 0; }
    if (kind === 7) { title = 'Damage needs different evidence'; shortTitle = 'Damage claim'; complaint = 'My desk organiser arrived damaged. Please review the damage and a refund.'; category = 'damaged-unsupported-issue'; expectedOutcome = 'held'; expectedAmountMinor = 0; }
    if (kind === 8) { title = 'Two missing lines, unclear claim'; shortTitle = 'Ambiguous items'; complaint = 'Some items are missing from my order. Please check the packing record.'; category = 'multiple-missing-ambiguity'; expectedOutcome = 'held'; expectedAmountMinor = 0; }
    if (kind === 9) { title = 'Historical remedy already recorded'; shortTitle = 'Previous remedy'; complaint = 'The travel pouch is missing. Please refund the missing travel pouch.'; category = 'seeded-historical-remedy'; expectedOutcome = 'already-resolved'; }
    if (kind === 10) { title = 'Original desk mat request'; shortTitle = 'Original claim'; complaint = 'The desk mat is missing. Please refund the missing desk mat.'; category = 'duplicate-original'; }
    if (kind === 11) { title = 'Follow-up for the same desk mat'; shortTitle = 'Duplicate claim'; complaint = 'The desk mat is missing. This is a follow-up on the same order and item.'; category = 'duplicate-follow-up'; }
    if (kind === 12) { title = 'Pen set omitted'; shortTitle = 'Missing pen set'; complaint = 'The pen set is missing from my order. Please refund the missing pen set.'; category = 'eligible-missing-item'; }

    if (kind !== 11) {
      const lines = [
        { id: `${orderId}-L1`, name, unitAmountMinor: unit, ordered, packed },
        { id: `${orderId}-L2`, name: kind === 8 ? 'Marker set' : 'Pocket notebook', unitAmountMinor: 500, ordered: 1, packed: kind === 8 ? 0 : 1 },
        { id: `${orderId}-L3`, name: 'Paper clips', unitAmountMinor: 300, ordered: 1, packed: 1 },
      ];
      const totalMinor = lines.reduce((sum, line) => sum + line.ordered * line.unitAmountMinor, 0);
      orders.push({
        id: orderId, label: `${orderId} · ${GBP(totalMinor)} · ${shortTitle.toLowerCase()}`, totalMinor, currency: 'gbp', synthetic: true, sampleComplaint: complaint,
        delivery: { status: 'delivered', disputed: kind === 5, detail: kind === 5 ? 'Synthetic courier scan says delivered; the fictional request disputes receipt. No delivery photograph or recipient confirmation is supplied.' : kind === 9 ? 'Synthetic parcel received. The omitted item has a labelled historical local remedy fixture.' : 'Synthetic parcel received. Quantities below are the supplied fictional packing record.' },
        lines,
      });
    }
    cases.push({ id: caseId, caseId: label, title, shortTitle, orderId, complaint });
    scenarios.push({ caseId, category, expectedOutcome, expectedAmountMinor, ...(kind === 11 ? { dependsOn: `${prefix}-C${pad(index - 1)}` } : {}) });
    if (kind === 9) {
      const order = orders.at(-1);
      const operationId = `${prefix}-HISTORY-${pad(index)}`;
      const idempotencyKey = `refund-office-seed-${id}-${pad(index)}`;
      const lineId = order.lines[0].id;
      seedOperations.push({
        id: operationId, orderId, lineId, issue: 'item_missing', amountMinor: unit, status: 'succeeded', seeded: true, provider: 'local', idempotencyKey, createdAt: HISTORY_AT,
        payload: { operationId, idempotencyKey, order, amountMinor: unit, lineId, issue: 'item_missing' },
        receipt: { id: `DEMO-HISTORY-${prefix}-${pad(index)}`, provider: 'local', amountMinor: unit, currency: 'gbp', status: 'succeeded', createdAt: HISTORY_AT, operationId, seeded: true },
      });
    }
  }
  return {
    schemaVersion: 1, id, title: count === 12 ? 'Focused demonstration: 12 synthetic cases' : 'Busy office: 50 synthetic cases', synthetic: true,
    merchant: { id: 'paper-harbour-demo', name: 'Paper Harbour Demo Shop', currency: 'gbp', synthetic: true },
    policy: { limitMinor: 2500, version: 1 }, orders, cases, seedOperations, scenarios,
  };
}

export function intakePayloads(dataset) {
  return dataset.cases.map(item => ({ eventId: `demo-${dataset.id}-${item.id}`, orderId: item.orderId, complaint: item.complaint }));
}

export function outcomeCsv(datasets) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [['dataset', 'case_id', 'case_label', 'order_id', 'category', 'expected_initial_outcome', 'expected_proposal_minor', 'depends_on', 'manual_follow_up']];
  for (const dataset of datasets) for (const scenario of dataset.scenarios) {
    const item = dataset.cases.find(item => item.id === scenario.caseId);
    const followup = scenario.dependsOn ? 'After the original is explicitly approved and simulated payment completes, re-investigate this case: already-resolved; additional refund 0.' : scenario.category === 'seeded-historical-remedy' ? 'Historical local fixture only; additional refund 0. No new approval or payment was fabricated.' : 'Investigation alone issues no refund. Any new refund requires explicit human approval.';
    rows.push([dataset.id, item.id, item.caseId, item.orderId, scenario.category, scenario.expectedOutcome, scenario.expectedAmountMinor, scenario.dependsOn || '', followup]);
  }
  return rows.map(row => row.map(quote).join(',')).join('\n') + '\n';
}

export function generateDemoData(directory = fileURLToPath(new URL('../demo-data/', import.meta.url))) {
  mkdirSync(directory, { recursive: true });
  const datasets = ['focused-12', 'busy-50'].map(buildDemoDataset);
  for (const dataset of datasets) {
    writeFileSync(resolve(directory, `${dataset.id}.json`), JSON.stringify(dataset, null, 2) + '\n');
    writeFileSync(resolve(directory, `n8n-intake.${dataset.id}.json`), JSON.stringify(intakePayloads(dataset), null, 2) + '\n');
  }
  writeFileSync(resolve(directory, 'expected-outcomes.csv'), outcomeCsv(datasets));
  return datasets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const datasets = generateDemoData();
  for (const dataset of datasets) console.log(`${dataset.id}: ${dataset.cases.length} synthetic cases, ${dataset.orders.length} orders, ${dataset.seedOperations.length} historical local fixtures.`);
}
