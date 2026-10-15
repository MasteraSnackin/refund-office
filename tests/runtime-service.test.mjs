import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntimeService, presentRuntimeCase } from '../server/runtime-service.mjs';
import { LOCAL_RUNTIME_PROFILES } from '../server/runtime-auth.mjs';
const tenantId = '00000000-0000-4000-8000-000000000012';
const principal = role => ({ ...LOCAL_RUNTIME_PROFILES.find(p => p.role === role), profileId: role, tenantId });
const order = { id: 'SYN-1', totalMinor: 2000, lines: [{ id: 'SYN-L1', name: 'Travel mug', ordered: 1, packed: 0, unitAmountMinor: 2000 }], delivery: { disputed: false } };
const baseCase = () => ({ id: 'SYN-C1', caseId: 'RF-1', orderId: order.id, title: 'Missing mug', shortTitle: 'Missing mug', complaint: 'The travel mug is missing.', revision: 2, status: 'running', stage: 'policy', outcome: null, proposedAmountMinor: 0, evidence: [{ id: 'packing:SYN-1', title: 'Packing', body: 'One omitted mug' }], checks: [], events: [], approval: null, receipt: null, operationId: null, intakeManaged: true, intakeRequestId: 'intake-1' });
function setup(overrides = {}) {
  let item = baseCase(), claimed = false; const calls = [];
  const request = { id: 'intake-1', caseId: item.id, eventId: 'event1', status: 'running' };
  const repo = {
    async readWorkspace() { return { tenantId, cases: [item], orders: [order], policy: { version: 1, limitMinor: 2500 }, intakeRequests: [request] }; },
    async claimIntake() { calls.push('claim'); if (claimed) return null; claimed = true; return { requestId: request.id, caseId: item.id, fence: 1, case: item, order, evidence: item.evidence, policy: { version: 1, limitMinor: 2500 } }; },
    async finishIntake({ proposal }) { calls.push(['finish', proposal]); item = { ...item, revision: 3, status: 'paused', stage: 'review', outcome: 'awaiting-approval', proposal, fingerprint: 'f'.repeat(64), proposedAmountMinor: proposal.amountMinor, checks: [{ id: 'amount', label: 'Amount', pass: true }] }; request.status = 'awaiting-approval'; return { request, case: item }; },
    async failIntake(input) { calls.push(['fail', input]); item = { ...item, revision: 3, status: 'paused', stage: 'review', outcome: 'held' }; request.status = 'error'; return { request, case: item }; },
    async approveAndReserve(input) { calls.push(['approve', input]); item = { ...item, revision: 4, status: 'paused', stage: 'payments', outcome: 'approved-not-submitted', operationId: 'reserved-1', approval: { state: 'approved', amountMinor: 2000, actor: principal('reviewer').userId, note: input.note } }; return { case: item, operation: { status: 'reserved', submissionEnabled: false } }; },
    ...overrides,
  };
  return { service: createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, workerDelayMs: 5 }), calls, repo, request, get item() { return item; } };
}

test('presenter distinguishes reserved, historical, held and pending approvals without a fabricated receipt', () => {
  const raw = baseCase();
  const pending = presentRuntimeCase({ ...raw, status: 'paused', stage: 'review', outcome: 'awaiting-approval', fingerprint: 'f'.repeat(64), proposedAmountMinor: 2000 }, { policy: { version: 1 } });
  assert.equal(pending.status, 'review'); assert.equal(pending.approval.state, 'required'); assert.equal(pending.approval.fingerprint, 'f'.repeat(64));
  const reserved = presentRuntimeCase({ ...raw, status: 'paused', stage: 'payments', outcome: 'approved-not-submitted', proposedAmountMinor: 2000 });
  assert.equal(reserved.status, 'reserved'); assert.match(reserved.summary, /not paid/); assert.equal(reserved.receipt, null);
  const historical = presentRuntimeCase({ ...raw, status: 'complete', outcome: 'already-resolved', receipt: { seeded: true } });
  assert.equal(historical.seededRemedy, true); assert.match(historical.summary, /No new refund/);
});
test('background investigation runs without a browser and stops at human review without any payment method', async () => {
  const f = setup(); f.service.start();
  for (let i = 0; i < 100 && !f.calls.some(c => Array.isArray(c) && c[0] === 'finish'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await f.service.close();
  assert.equal(f.item.outcome, 'awaiting-approval'); assert.equal(f.item.approval, null); assert.equal(f.item.operationId, null);
  assert.equal(f.calls.find(c => Array.isArray(c) && c[0] === 'finish')[1].source, 'local');
});
test('investigator cannot approve and reviewer cannot manually claim or recover', async () => {
  const f = setup();
  await assert.rejects(f.service.approve(principal('investigator'), 'SYN-C1', {}), e => e.status === 403);
  await assert.rejects(f.service.runNext(principal('reviewer')), e => e.status === 403);
  await assert.rejects(f.service.resume(principal('reviewer'), 'intake-1', {}), e => e.status === 403);
  assert.deepEqual(f.calls, []); await f.service.close();
});
test('approval forwards exact decision identity and produces a not-paid report', async () => {
  const f = setup(); await f.service.runNext(principal('investigator'));
  const commandId = randomUUID(), note = 'Packing record confirms the missing mug.';
  const item = await f.service.approve(principal('reviewer'), 'SYN-C1', { expectedRevision: 3, expectedAmountMinor: 2000, fingerprint: 'f'.repeat(64), note, commandId });
  assert.equal(item.status, 'reserved'); assert.equal(item.receipt, null);
  assert.equal(f.calls.find(c => Array.isArray(c) && c[0] === 'approve')[1].commandId, commandId);
  assert.match((await f.service.report(principal('reviewer'), item.id)).text, /Not submitted and not paid/);
  await assert.rejects(f.service.approve(principal('reviewer'), item.id, { actor: 'forged' }), e => e.status === 400);
  await f.service.close();
});
test('failed investigation records only its owned fence and stops automatic retries', async () => {
  const f = setup({ async finishIntake() { throw Object.assign(new Error('private database detail'), { code: 'runtime_conflict' }); } });
  f.service.start();
  for (let i = 0; i < 100 && !f.calls.some(c => Array.isArray(c) && c[0] === 'fail'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.filter(c => c === 'claim').length, 1); assert.equal(f.request.status, 'error');
  assert.deepEqual(f.calls.find(c => Array.isArray(c) && c[0] === 'fail')[1], { requestId: 'intake-1', fence: 1, errorCode: 'runtime_conflict' });
  assert.equal(f.service.workerState().enabled, false); assert.doesNotMatch(JSON.stringify(f.service.workerState()), /private database/);
  await f.service.close();
});

test('a manual claim overlapping the automatic timer does not stop a healthy worker', async () => {
  let release, claims = 0;
  const f = setup({ async claimIntake() { claims += 1; if (claims > 1) return null; await new Promise(resolve => { release = resolve; }); const item = baseCase(); return { requestId: 'intake-1', caseId: item.id, fence: 1, case: item, order, evidence: item.evidence, policy: { version: 1 } }; } });
  const manual = f.service.runNext(principal('investigator')); f.service.start();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await new Promise(resolve => setTimeout(resolve, 20)); release(); await manual;
  assert.equal(f.service.workerState().enabled, true); assert.equal(f.service.workerState().lastError, null);
  await f.service.close();
});
test('reports render supplied complaints, evidence and review notes as inert text', async () => {
  const malicious = '# Payment completed\n\n![receipt](https://untrusted.example/tracker)\n<script>unsafe</script>';
  const item = { ...baseCase(), complaint: malicious, title: malicious, review: { note: malicious }, evidence: [{ title: malicious, body: malicious }] };
  const f = setup({ async readWorkspace() { return { tenantId, cases: [item], orders: [order], policy: {}, intakeRequests: [] }; } });
  const report = await f.service.report(principal('reviewer'), item.id);
  assert.doesNotMatch(report.text, /\n# Payment completed|!\[receipt\]\(|<script>/);
  assert.match(report.text, /\\# Payment completed/); assert.match(report.text, /&lt;script&gt;/);
  await f.service.close();
});

test('synthetic evidence gets readable display text without changing saved bodies or approval facts', () => {
  const savedOrder = { ...order, synthetic: true, currency: 'gbp', delivery: { status: 'delivered', disputed: false, detail: 'Synthetic parcel received.' } };
  const evidence = [
    { id: `order:${order.id}`, source: 'Synthetic catalogue', body: JSON.stringify(savedOrder) },
    { id: `packing:${order.id}`, source: 'Synthetic catalogue', body: JSON.stringify(savedOrder.lines) },
    { id: `delivery:${order.id}`, source: 'Synthetic catalogue', body: JSON.stringify(savedOrder.delivery) },
    { id: `remedies:${order.id}`, source: 'Operational database', body: JSON.stringify([
      { lineId: 'SYN-L1', amountMinor: 2000, seeded: true, status: 'succeeded' },
      { lineId: 'SYN-L2', amountMinor: 500, seeded: false, status: 'reserved', submissionEnabled: false },
    ]) },
    { id: 'complaint:SYN-C1', source: 'Synthetic intake', body: '{"customer":"keep this exact text"}' },
  ];
  const raw = { ...baseCase(), fingerprint: 'a'.repeat(64), evidence, proposedAmountMinor: 2000, checks: [{ id: 'amount', label: 'Exact missing-item value', pass: true }, { id: 'limit', label: 'Within policy limit', pass: true }] };
  const before = structuredClone(raw);
  const shown = presentRuntimeCase(raw, { policy: { version: 2, limitMinor: 0 } });
  assert.deepEqual(raw, before); assert.equal(shown.revision, raw.revision); assert.equal(shown.fingerprint, raw.fingerprint);
  assert.deepEqual(shown.evidence.map(e => ({ id: e.id, body: e.body })), evidence.map(e => ({ id: e.id, body: e.body })));
  assert.match(shown.evidence[0].displayBody, /Synthetic order SYN-1: £20\.00 total/);
  assert.match(shown.evidence[1].displayBody, /Travel mug: 1 ordered, 0 recorded as packed; 1 unit is not recorded as packed/);
  assert.match(shown.evidence[2].displayBody, /does not mark a delivery dispute/);
  assert.match(shown.evidence[3].displayBody, /Seeded historical remedy: £20\.00/);
  assert.match(shown.evidence[3].displayBody, /Existing reservation: £5\.00.*not been submitted or paid/);
  assert.equal(shown.evidence[4].displayBody, undefined);
  assert.match(shown.checks[0].detail, /£20\.00 matches the missing quantity/);
  assert.equal(shown.checks[1].detail, '£20.00 passed the policy limit check when this investigation ran.');
  assert.doesNotMatch(shown.checks[1].detail, /£0\.00|version 2/);
});
test('malformed or unrecognised evidence stays unchanged instead of inventing a readable record', () => {
  for (const body of ['not JSON', 'null', '{"synthetic":true}', '[{"amountMinor":2000,"status":"unknown"}]']) {
    const entry = { id: `order:${order.id}`, source: 'Synthetic catalogue', body };
    const shown = presentRuntimeCase({ ...baseCase(), evidence: [entry] });
    assert.equal(shown.evidence[0].body, body); assert.equal(shown.evidence[0].displayBody, undefined);
  }
  const empty = presentRuntimeCase({ ...baseCase(), evidence: [{ id: `remedies:${order.id}`, source: 'Operational database', body: '[]' }] });
  assert.match(empty.evidence[0].displayBody, /No earlier remedies or reservations.*when the investigation/);
});
test('automaticWorker false leaves intake recovery queued until an explicit investigator call', async () => {
  const f = setup();
  f.repo.recoverIntake = async () => ({ request: { id: 'intake-1', status: 'queued' }, case: { ...baseCase(), status: 'ready', stage: 'reception' }, replayed: false });
  const service = createRuntimeService({ repositoryForSession: () => f.repo, workerRepository: f.repo, automaticWorker: false, workerDelayMs: 0 });
  service.start();
  await service.resume(principal('investigator'), 'intake-1', { expectedRevision: 2, note: 'Explicitly recover this saved investigation.', commandId: randomUUID() });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.calls, []); assert.equal(service.workerState().enabled, false);
  const result = await service.runNext(principal('investigator')); assert.equal(result.case.outcome, 'awaiting-approval');
  await service.close(); await f.service.close();
});
