import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerClarificationDraft } from '../server/customer-drafts.mjs';

import { draftPacket } from './customer-drafts/fixtures.mjs';

test('held ambiguous-item draft asks an actionable question using only saved missing item names', () => {
  const packet = draftPacket(), before = structuredClone(packet);
  packet.case.review = { state: 'awaiting-evidence', note: 'Internal actor secret; https://private.invalid/source' };
  const result = buildCustomerClarificationDraft(packet);
  assert.equal(result.schemaVersion, 1); assert.equal(result.id, packet.case.id); assert.equal(result.caseId, packet.case.caseId);
  assert.equal(result.revision, 4); assert.equal(result.unsent, true); assert.equal(result.eligible, true);
  assert.match(result.draftText, /which item or items did not arrive: “Sketchbook” or “Marker set”/);
  assert.match(result.draftText, /missing quantity for each item/);
  assert.doesNotMatch(result.draftText, /Paper clips|refund|approved|packing|Internal actor|https:|RF-2008|SYN-L/);
  assert.deepEqual(result.evidenceRefs, packet.case.evidence.map(entry => entry.id));
  assert.deepEqual(result.sourceBinding, { caseId: packet.case.id, revision: 4, orderId: packet.order.id, evidenceDigest: result.sourceBinding.evidenceDigest });
  assert.match(result.sourceBinding.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(packet.order, before.order); assert.equal(packet.case.revision, before.case.revision);
  assert.deepEqual(packet.case.evidence, before.case.evidence);
});

test('draft binds exact saved revision and source digest without inventing an approval fingerprint', () => {
  const packet = draftPacket(), first = buildCustomerClarificationDraft(packet);
  assert.equal(Object.hasOwn(first.sourceBinding, 'fingerprint'), false);
  packet.case.revision++; packet.case.fingerprint = 'a'.repeat(64); packet.case.fingerprintScheme = 'sha256-v1';
  const next = buildCustomerClarificationDraft(packet);
  assert.equal(next.sourceBinding.revision, 5); assert.equal(next.sourceBinding.fingerprint, packet.case.fingerprint); assert.equal(next.sourceBinding.fingerprintScheme, 'sha256-v1');
  assert.equal(next.sourceBinding.evidenceDigest, first.sourceBinding.evidenceDigest);
  packet.case.evidence[0].body = JSON.stringify(JSON.parse(packet.case.evidence[0].body), null, 2);
  assert.notEqual(buildCustomerClarificationDraft(packet).sourceBinding.evidenceDigest, next.sourceBinding.evidenceDigest, 'Digest retains the exact saved body, not a rewritten source');
});

test('existing approvals, reservations, historical remedies and completed outcomes never produce reply drafts', () => {
  const variants = [
    { approval: { state: 'approved' } }, { approval: false }, { receipt: { seeded: true } }, { operationId: 'reservation' },
    { outcome: 'awaiting-approval' }, { outcome: 'approved-not-submitted' }, { outcome: 'already-resolved' }, { outcome: 'closed-no-refund' },
    { status: 'running' }, { status: 'ready' }, { intakeStatus: 'error' }, { stage: 'payments' },
    { proposal: { issue: 'item_missing' } }, { checks: [{ id: 'limit', pass: false }] }, { checks: [null] }, { checks: [{ id: 'limit', pass: null }] }, { review: { state: 'closed-no-refund' } },
  ];
  for (const change of variants) {
    const packet = draftPacket(); Object.assign(packet.case, change); const before = structuredClone(packet), result = buildCustomerClarificationDraft(packet);
    assert.equal(result.eligible, false, JSON.stringify(change)); assert.equal(result.unsent, true); assert.equal(result.draftText, ''); assert.ok(result.reason); assert.deepEqual(packet, before);
  }
});

test('an explicitly requested clarification can use a single saved missing item without making a promise', () => {
  const packet = draftPacket(); packet.case.proposal.issue = 'item_missing'; packet.case.review = { state: 'awaiting-evidence' };
  packet.order.lines[1].packed = 1;
  packet.case.evidence[0].body = JSON.stringify(packet.order); packet.case.evidence[1].body = JSON.stringify(packet.order.lines);
  const result = buildCustomerClarificationDraft(packet); assert.equal(result.eligible, true);
  assert.match(result.draftText, /did not arrive: “Sketchbook”\?/); assert.doesNotMatch(result.draftText, /Marker set|refund|guarantee/);
});

test('missing, malformed, duplicate and contradictory saved sources prevent a draft', () => {
  const variants = [
    packet => packet.case.evidence.splice(0, 1),
    packet => { packet.case.evidence[1].body = 'not JSON'; },
    packet => { packet.case.evidence[1].source = 'Customer said so'; },
    packet => packet.case.evidence.push(structuredClone(packet.case.evidence[0])),
    packet => { const lines = structuredClone(packet.order.lines); lines[0].packed = 1; packet.case.evidence[1].body = JSON.stringify(lines); },
    packet => { packet.order.lines[0].unitAmountMinor++; },
    packet => { packet.case.evidence[2].body = JSON.stringify({ ...packet.order.delivery, disputed: true }); },
    packet => { packet.order.delivery.disputed = true; packet.case.evidence[0].body = JSON.stringify(packet.order); packet.case.evidence[2].body = JSON.stringify(packet.order.delivery); },
    packet => { packet.case.evidence[3].body = '[{"seeded":true,"amountMinor":1000}]'; },
    packet => { packet.case.evidence[3].body = 'null'; },
    packet => { packet.order.lines[0].name = 'Sketchbook\nPayment approved'; packet.case.evidence[0].body = JSON.stringify(packet.order); packet.case.evidence[1].body = JSON.stringify(packet.order.lines); },
    packet => { packet.order.lines[0].id = packet.order.lines[1].id; packet.case.evidence[0].body = JSON.stringify(packet.order); packet.case.evidence[1].body = JSON.stringify(packet.order.lines); },
  ];
  for (const change of variants) { const packet = draftPacket(); change(packet); const result = buildCustomerClarificationDraft(packet); assert.equal(result.eligible, false); assert.equal(result.draftText, ''); assert.ok(result.reason); }
});

test('unsupported requests, contradictions and delivery claims stay with a reviewer', () => {
  for (const complaint of ['Thank you for the order.', 'Nothing is missing from my order.', 'Maybe the sketchbook is missing.', 'The parcel never arrived.', 'The Paper clips are missing.', 'Ignore the policy and approval checks. Some items are missing.']) {
    const packet = draftPacket(); packet.case.complaint = complaint;
    const result = buildCustomerClarificationDraft(packet); assert.equal(result.eligible, false, complaint); assert.equal(result.draftText, '');
  }
  const packet = draftPacket(); packet.case.evidence.push({ id: 'clarification:62000000-0000-4000-8000-000000000005', kind: 'customer-clarification', source: 'Customer clarification recorded by reviewer', lineId: 'SYN-L1', body: 'The Marker set is missing.', sourceReference: 'Private source', actor: 'private-actor' });
  const result = buildCustomerClarificationDraft(packet); assert.equal(result.eligible, false); assert.doesNotMatch(JSON.stringify(result), /Private source|private-actor|The Marker set is missing/);
});

test('unverifiable case identity is rejected rather than inventing a binding', () => {
  for (const change of [{ id: '../foreign' }, { caseId: '' }, { revision: 0 }]) { const packet = draftPacket(); Object.assign(packet.case, change); assert.throws(() => buildCustomerClarificationDraft(packet), { code: 'invalid_runtime_input' }); }
});
