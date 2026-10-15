import test from 'node:test';
import assert from 'node:assert/strict';
import { caseStatus, caseBucket, filterCases, summariseCases } from '../src/case-view.js';

const item = (id, status, extra = {}) => ({ id, caseId: `RF-${id}`, orderId: `DEMO-${id}`, title: 'Missing item', complaint: 'My blue mug was missing.', status, ...extra });
const receipt = (id, extra = {}) => ({ id, operationId: `operation-${id}`, amountMinor: 2000, status: 'succeeded', currency: 'gbp', provider: 'local', ...extra });

test('status buckets keep unconfirmed and review cases out of resolved counts', () => {
  const cases = [item(1, 'ready'), item(2, 'running'), item(3, 'paused'), item(4, 'review'), item(5, 'pending'), item(6, 'error'), item(7, 'complete'), item(8, 'closed', { outcome: 'closed-no-refund' })];
  assert.deepEqual(cases.map(caseBucket), ['open', 'open', 'open', 'attention', 'attention', 'attention', 'resolved', 'resolved']);
  assert.equal(caseStatus(item(4, 'review', { review: { state: 'awaiting-evidence' } })).label, 'Awaiting evidence');
  assert.equal(caseStatus(item(8, 'closed', { outcome: 'closed-no-refund' })).label, 'Closed · no refund');
  assert.deepEqual(summariseCases(cases), { total: 8, attention: 3, open: 3, resolved: 2, recordedMinor: 0, recordedCount: 0, localMinor: 0, stripeMinor: 0 });
});

test('a proposed refund awaiting human approval needs attention and does not count as recorded', () => {
  const waiting = item(110, 'review', { outcome: 'awaiting-approval', stage: 'review', proposedAmountMinor: 2000, approval: { state: 'required', amountMinor: 2000 } });
  const approved = item(111, 'running', { stage: 'payments', proposedAmountMinor: 2000, approval: { state: 'approved', amountMinor: 2000 } });
  assert.deepEqual(caseStatus(waiting), { label: 'Awaiting approval', tone: 'warning' });
  assert.equal(caseBucket(waiting), 'attention');
  assert.deepEqual(filterCases([waiting, approved], { filter: 'attention' }), [waiting]);
  assert.deepEqual(caseStatus(approved), { label: 'In progress', tone: 'working' });
  assert.equal(caseBucket(approved), 'open');
  assert.equal(summariseCases([waiting, approved]).recordedMinor, 0);
  assert.equal(summariseCases([waiting, approved]).recordedCount, 0);
});

test('search matches case, order, title and request, and combines with the status filter', () => {
  const cases = [item(104, 'complete'), item(105, 'review', { complaint: 'My parcel never arrived.' }), item(106, 'paused', { title: 'Damaged notebook', complaint: 'The cover is split.' })];
  for (const query of ['rf-104', 'demo-104', 'BLUE mug', 'missing item blue', '  mug  ']) assert.deepEqual(filterCases(cases, { query }).map(c => c.id), [104]);
  assert.deepEqual(filterCases(cases, { filter: 'attention', query: 'parcel' }).map(c => c.id), [105]);
  assert.deepEqual(filterCases(cases, { filter: 'open', query: 'notebook' }).map(c => c.id), [106]);
  assert.deepEqual(filterCases(cases, { filter: 'resolved', query: 'parcel' }), []);
  assert.deepEqual(filterCases(cases, { query: 'unmatched' }), []);
  assert.deepEqual(filterCases(cases, { filter: 'unknown', query: ' ' }), cases);
});

test('recorded totals count one succeeded receipt across original and duplicate cases', () => {
  const shared = receipt('local-104');
  const cases = [item(104, 'complete', { receipt: shared }), item(107, 'complete', { outcome: 'already-resolved', receipt: { ...shared } }), item(108, 'complete', { receipt: receipt('stripe-108', { amountMinor: 1299, provider: 'stripe-sandbox' }) })];
  const result = summariseCases(cases);
  assert.equal(result.recordedCount, 2);
  assert.equal(result.recordedMinor, 3299);
  assert.equal(result.localMinor, 2000);
  assert.equal(result.stripeMinor, 1299);
});

test('receipt and operation aliases prevent double counting when one reference lacks an operation ID', () => {
  const cases = [item(1, 'complete', { receipt: receipt('shared', { operationId: undefined }) }), item(2, 'complete', { receipt: receipt('shared') }), item(3, 'complete', { receipt: receipt('different-reference', { operationId: 'operation-shared' }) })];
  assert.equal(summariseCases(cases).recordedCount, 1);
  assert.equal(summariseCases(cases).recordedMinor, 2000);
});

test('seeded history, pending, failed and invalid amounts never inflate recorded refunds', () => {
  const cases = [
    item(1, 'complete', { receipt: receipt('DEMO-REMEDY-106') }),
    item(2, 'complete', { receipt: receipt('seed-alias', { operationId: 'seed-remedy-106' }) }),
    item(3, 'complete', { operationId: 'seed-remedy-106', receipt: receipt('seed-fallback', { operationId: undefined }) }),
    item(4, 'pending', { receipt: receipt('pending', { status: 'pending' }) }),
    item(5, 'error', { receipt: receipt('failed', { status: 'failed' }) }),
    item(6, 'error', { receipt: receipt('cancelled', { status: 'canceled' }) }),
    item(7, 'complete', { receipt: receipt('negative', { amountMinor: -2000 }) }),
    item(8, 'complete', { receipt: receipt('fraction', { amountMinor: 20.5 }) }),
    item(9, 'complete', { receipt: receipt('zero', { amountMinor: 0 }) }),
    item(10, 'complete', { receipt: receipt('valid', { amountMinor: 1250 }) }),
    item(11, 'complete', { receipt: receipt('DEMO-HISTORY-FOCUSED', { seeded: true, operationId: 'synthetic-history-other' }) }),
  ];
  const result = summariseCases(cases);
  assert.equal(result.recordedCount, 1);
  assert.equal(result.recordedMinor, 1250);
  assert.equal(result.localMinor, 1250);
});
