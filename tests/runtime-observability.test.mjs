import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createLocalObserver } from '../server/observability.mjs';

const tenantId = '71000000-0000-4000-8000-000000000001';
const principal = role => ({ tenantId, userId: role === 'reviewer' ? '71000000-0000-4000-8000-000000000002' : '71000000-0000-4000-8000-000000000003', role });
const privateText = 'Private evidence: secret customer@example.invalid and sk_test_keep_private';
const order = { id: 'SYN-TRACE-O1', lines: [{ id: 'SYN-TRACE-L1', name: 'Travel mug', ordered: 1, packed: 0, unitAmountMinor: 2000 }], delivery: { disputed: false } };
function fixture(observer) {
  let claimed = false, writes = 0;
  let item = { id: 'SYN-TRACE-C1', caseId: 'RF-9999', orderId: order.id, revision: 2, status: 'running', stage: 'policy', complaint: `The travel mug is missing. ${privateText}`, evidence: [{ id: 'packing:SYN-TRACE-O1', body: privateText }], checks: [], events: [], approval: null, receipt: null, operationId: null };
  const request = { id: 'private-request-1', caseId: item.id, status: 'running' };
  const saved = () => ({ case: structuredClone(item), request: { ...request } });
  const repo = {
    async readWorkspace() { return { tenantId, cases: [structuredClone(item)], orders: [order], intakeRequests: [request], policy: { version: 1 } }; },
    async claimIntake() { if (claimed) return null; claimed = true; return { requestId: request.id, caseId: item.id, case: structuredClone(item), order, evidence: item.evidence, policy: { version: 1 }, fence: 1 }; },
    async finishIntake({ proposal }) { writes++; item = { ...item, revision: 3, status: 'paused', stage: 'review', proposal, proposedAmountMinor: proposal.amountMinor, outcome: 'awaiting-approval', checks: [{ id: 'amount', pass: true }, { id: 'evidence', pass: true }] }; request.status = 'awaiting-approval'; return saved(); },
    async enqueueIntake() { writes++; return saved(); },
    async reviewCase() { writes++; item = { ...item, revision: item.revision + 1, outcome: 'held', review: { state: 'awaiting-evidence' } }; return structuredClone(item); },
    async submitClarification() { writes++; item = { ...item, revision: item.revision + 1, status: 'ready', stage: 'reception', outcome: null }; return { ...saved(), submission: { actor: principal('reviewer').userId } }; },
    async recoverIntake() { writes++; return saved(); },
    async approveAndReserve() { writes++; item = { ...item, revision: item.revision + 1, outcome: 'approved-not-submitted', approval: { state: 'approved', actor: principal('reviewer').userId, amountMinor: 2000 }, operationId: 'private-reservation' }; return saved(); },
  };
  const service = createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, automaticWorker: false, evidenceClarification: true, observer, packId: 'focused-12' });
  return { service, repo, get writes() { return writes; }, get item() { return item; } };
}
const decision = revision => ({ expectedRevision: revision, note: privateText, commandId: randomUUID() });

test('runtime records actual nested local investigation and policy results, without text or identities', async () => {
  const observer = createLocalObserver(), f = fixture(observer);
  try {
    const result = await f.service.runNext(principal('investigator'));
    await observer.flush();
    const spans = observer.snapshot().spans;
    assert.equal(spans.length, 4);
    const root = spans.find(span => span.name === 'refund.investigation');
    assert.equal(root.parentSpanId, null);
    assert.equal(root.attributes['decision.state'], result.case.outcome);
    assert.equal(root.attributes['case.revision'], result.case.revision);
    assert.equal(root.attributes.caseId, result.case.caseId);
    assert.equal(root.attributes.amountMinor, result.case.proposedAmountMinor);
    assert.equal(root.attributes.packId, 'focused-12');
    const children = spans.filter(span => span.parentSpanId === root.spanId);
    assert.deepEqual(children.map(span => span.name).sort(), ['refund.investigation.claim', 'refund.investigation.finish', 'refund.investigation.propose']);
    assert.ok(spans.every(span => span.traceId === root.traceId && span.status === 'OK' && span.attributes.provider === 'local'));
    assert.ok(spans.every(span => span.attributes.caseId === result.case.caseId && span.attributes.analyser === 'local-rules'));
    const finish = spans.find(span => span.name.endsWith('.finish'));
    assert.equal(finish.attributes['checks.count'], 2); assert.equal(finish.attributes['checks.passed'], 2);
    const serialised = JSON.stringify(observer.snapshot());
    for (const secret of [privateText, principal('reviewer').userId, principal('investigator').userId, tenantId, order.id, f.item.id, 'private-request-1']) assert.ok(!serialised.includes(secret));
    assert.equal(f.writes, 1); assert.equal(result.case.approval, null); assert.equal(result.case.operationId, null);
    assert.equal((await f.service.bootstrap(principal('reviewer'))).runtime.observability.retainedSpans, 4);
  } finally { await f.service.close(); }
});

test('empty queue polls and saved-case reads do not create retrospective spans', async () => {
  const observer = createLocalObserver(), f = fixture(observer);
  try {
    await f.service.runNext(principal('investigator'));
    const before = observer.snapshot();
    for (let i = 0; i < 4; i++) assert.deepEqual(await f.service.runNext(principal('investigator')), { empty: true });
    await f.service.getCase(principal('reviewer'), f.item.id);
    await f.service.bootstrap(principal('reviewer'));
    assert.deepEqual(observer.snapshot(), before);
  } finally { await f.service.close(); }
});

test('intake, actual human actions, clarification and recovery have separate redacted spans', async () => {
  const observer = createLocalObserver(), f = fixture(observer), reviewer = principal('reviewer'), investigator = principal('investigator');
  try {
    await f.service.intake(investigator, { eventId: 'private-event', orderId: order.id, complaint: privateText });
    await f.service.review(reviewer, f.item.id, { ...decision(2), action: 'request-evidence' });
    await f.service.submitClarification(reviewer, f.item.id, { ...decision(3), lineId: order.lines[0].id, customerStatement: privateText, sourceReference: privateText });
    await f.service.resume(investigator, 'private-request-1', decision(4));
    await f.service.approve(reviewer, f.item.id, { ...decision(4), expectedAmountMinor: 2000, fingerprint: 'f'.repeat(64) });
    assert.deepEqual(observer.snapshot().spans.map(span => span.name), ['refund.intake', 'refund.review.decide', 'refund.evidence.clarify', 'refund.investigation.recover', 'refund.review.approve']);
    assert.equal(observer.snapshot().spans.at(-1).attributes['decision.state'], 'approved-not-submitted');
    assert.ok(!JSON.stringify(observer.snapshot()).includes(privateText));
    assert.equal(f.writes, 5);
  } finally { await f.service.close(); }
});

test('broken recorders cannot skip, repeat or replace an intake mutation or its result', async () => {
  const failures = [
    { span() { throw new Error(privateText); } },
    { async span() { return null; } },
    { async span(_name, _attrs, callback) { await callback(); throw new Error(privateText); } },
    { async span(_name, _attrs, callback) { const result = await callback(); await callback(); return result; } },
    { async span(_name, _attrs, callback) { await Promise.resolve(); return callback(); } },
    { span(_name, _attrs, callback) { void callback(); return new Promise(() => {}); } },
  ];
  for (const observer of failures) {
    const f = fixture(observer);
    try {
      const result = await f.service.intake(principal('investigator'), { eventId: 'private-event', orderId: order.id, complaint: privateText });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.writes, 1); assert.equal(result.case.id, f.item.id); assert.equal(result.case.revision, 2);
      assert.doesNotMatch(JSON.stringify(f.service.observabilityStatus()), /Private evidence|customer@|sk_test/);
    } finally { await f.service.close(); }
  }
});

test('tracing preserves the exact underlying write error even if recorder replaces or suppresses it', async () => {
  const original = Object.assign(new Error(privateText), { code: 'runtime_write_unconfirmed', uncertain: true });
  for (const mode of ['throw', 'suppress']) {
    const observer = { async span(_name, _attrs, callback) { try { return await callback(); } catch { if (mode === 'throw') throw new Error('Replacement'); return null; } } };
    const f = fixture(observer); let calls = 0;
    f.repo.enqueueIntake = async () => { calls++; throw original; };
    try {
      await assert.rejects(f.service.intake(principal('investigator'), { eventId: 'event', orderId: order.id, complaint: privateText }), error => error === original);
      await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(f.service.observabilityStatus().degraded, true);
    } finally { await f.service.close(); }
  }
});

test('recorder metadata and flush failures stay redacted and do not fail service shutdown', async () => {
  const observer = { async span(_name, _attrs, callback) { return callback({ setAttributes() { throw new Error(privateText); } }); }, status() { throw new Error(privateText); }, async flush() { throw new Error(privateText); } };
  const f = fixture(observer);
  await f.service.intake(principal('investigator'), { eventId: 'event', orderId: order.id, complaint: privateText });
  assert.equal(f.writes, 1);
  assert.deepEqual(f.service.observabilityStatus(), { enabled: true, mode: 'local-only', networkEnabled: false, serviceFailures: 2, degraded: true });
  await f.service.close(); assert.equal(f.service.observabilityStatus().degraded, true);
});
