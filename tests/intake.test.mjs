import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createIntake } from '../server/intake.mjs';
import { createProviders } from '../server/providers.mjs';
import { createApiServer } from '../server/index.mjs';

const payload = (eventId = 'support-form:001', orderId = 'DEMO-104') => ({ eventId, orderId, complaint: 'The travel mug is missing from my parcel. Please refund that missing item.' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(check) {
  for (let count = 0; count < 200; count++) {
    const value = check();
    if (value) return value;
    await delay(5);
  }
  assert.fail('The local intake worker did not reach the expected state.');
}
function setup(t, { dbPath = ':memory:', stepDelayMs = 1, overrides = {} } = {}) {
  const store = createStore({ dbPath });
  const local = createProviders({ env: {} });
  const calls = { propose: 0, create: 0, retrieve: 0 };
  const provider = { ...local,
    proposeCase: async input => { calls.propose++; return local.proposeCase(input); },
    createRefund: async () => { calls.create++; throw new Error('Intake must never submit payment.'); },
    retrieveRefund: async () => { calls.retrieve++; throw new Error('Intake must never reconcile payment.'); },
    ...overrides,
  };
  const engine = createEngine({ store, provider });
  const intake = createIntake({ store, engine, stepDelayMs });
  t.after(async () => { await intake.close(); try { store.close(); } catch { /* Restart tests close earlier stores themselves. */ } });
  return { store, engine, intake, provider, calls };
}
const approvalInput = item => ({ expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note: 'The supplied packing evidence supports this exact demo refund.' });

async function reachReview(intake, engine, eventId = 'support-form:001') {
  const saved = intake.submit(payload(eventId));
  intake.start();
  await waitUntil(() => engine.getCase(saved.case.id).status === 'review');
  return engine.getCase(saved.case.id);
}

test('intake saves one case and request atomically before work; matching retry returns the same saved case', async t => {
  const { store, intake, engine } = setup(t);
  const before = store.cases().length;
  const first = intake.submit(payload());
  assert.equal(first.replayed, false); assert.equal(first.request.status, 'queued');
  assert.equal(first.case.intakeManaged, true); assert.equal(first.case.intakeRequestId, first.request.id);
  assert.equal(first.request.caseId, first.case.id); assert.equal(first.request.caseLabel, first.case.caseId);
  assert.equal(engine.getCase(first.case.id).status, 'ready');
  const second = intake.submit(payload());
  assert.equal(second.replayed, true); assert.equal(second.request.id, first.request.id); assert.deepEqual(second.case, first.case);
  assert.equal(store.cases().length, before + 1); assert.equal(store.intakeRequests().length, 1);
  assert.equal(second.request.payloadHash, undefined);
  assert.throws(() => intake.submit({ ...payload(), complaint: 'A different missing item is now claimed.' }), error => error.code === 'intake_event_conflict');
  assert.equal(store.cases().length, before + 1); assert.equal(store.intakeRequests().length, 1);
});

test('failed request persistence rolls back the new case', t => {
  const { store, intake } = setup(t);
  const before = store.cases().length;
  store.saveIntake = () => { throw new Error('Simulated persistence failure'); };
  assert.throws(() => intake.submit(payload()), /persistence failure/);
  assert.equal(store.cases().length, before); assert.equal(store.intakeRequests().length, 0);
});

test('background intake investigates without a browser and stops at human approval with no operation', async t => {
  const { store, intake, engine, calls } = setup(t);
  const item = await reachReview(intake, engine);
  assert.equal(item.outcome, 'awaiting-approval'); assert.equal(item.approval.state, 'required');
  assert.equal(item.proposedAmountMinor, 2000); assert.equal(item.operationId, undefined);
  assert.equal(store.operations(item.orderId).length, 0);
  assert.deepEqual(calls, { propose: 1, create: 0, retrieve: 0 });
  assert.equal(intake.list().requests[0].status, 'awaiting-review');
  assert.ok(item.events.some(event => event.label === 'Local intake event saved'));
  assert.ok(item.events.some(event => event.label === 'Human approval required'));
  assert.ok(store.cases().filter(candidate => !candidate.intakeManaged).every(candidate => candidate.status === 'ready'));
  await delay(20); assert.equal(engine.getCase(item.id).revision, item.revision);
});

test('manual pause persists and only explicit intake resume continues the same pre-payment case', async t => {
  const { intake, engine, store } = setup(t, { stepDelayMs: 20 });
  const saved = intake.submit(payload()); intake.start();
  await waitUntil(() => engine.getCase(saved.case.id).status === 'running');
  const paused = await engine.pause(saved.case.id);
  await waitUntil(() => intake.list().requests[0].status === 'paused');
  await delay(60); assert.equal(engine.getCase(paused.id).revision, paused.revision);
  const resumed = await intake.resume(saved.request.id);
  assert.equal(resumed.case.status, 'running'); assert.equal(resumed.request.status, 'running');
  await waitUntil(() => engine.getCase(paused.id).status === 'review');
  assert.equal(store.operations(paused.orderId).length, 0);
});

test('a restart recovers queued and running intake but never resumes a manually paused case or unrelated work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-office-intake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'test.sqlite');
  const first = setup(t, { dbPath });
  const running = first.intake.submit(payload('running'));
  const queued = first.intake.submit(payload('queued', 'DEMO-106'));
  const paused = first.intake.submit(payload('paused'));
  await first.engine.advanceIntake(running.case.id, running.request.id);
  first.store.saveIntake({ ...first.store.intakeRequest(running.request.id), status: 'running' });
  await first.engine.advanceIntake(paused.case.id, paused.request.id);
  await first.engine.pause(paused.case.id);
  first.store.saveIntake({ ...first.store.intakeRequest(paused.request.id), status: 'running' });
  await first.engine.run('missing-item');
  await first.intake.close(); first.store.close();
  const next = setup(t, { dbPath }); next.intake.start();
  await waitUntil(() => next.engine.getCase(running.case.id).status === 'review' && next.engine.getCase(queued.case.id).status === 'complete');
  assert.equal(next.engine.getCase(paused.case.id).status, 'paused');
  assert.equal(next.engine.getCase('missing-item').status, 'paused');
  assert.equal(next.store.intakeRequest(paused.request.id).status, 'paused');
  assert.equal(next.store.intakeRequest(queued.request.id).status, 'already-resolved');
  assert.equal(next.intake.submit(payload('running')).case.id, running.case.id);
  assert.equal(next.calls.create, 0); assert.equal(next.calls.retrieve, 0);
});

test('intake cannot advance or resume approved payment work, even when its request is erroneously requeued', async t => {
  const { intake, engine, store, calls } = setup(t);
  const required = await reachReview(intake, engine);
  const approved = await engine.approve(required.id, approvalInput(required));
  const operation = store.operation(approved.operationId);
  await assert.rejects(engine.advanceIntake(approved.id, approved.intakeRequestId), error => error.code === 'intake_payment_boundary');
  await engine.pause(approved.id);
  await assert.rejects(intake.resume(approved.intakeRequestId), error => error.code === 'intake_payment_boundary');
  await engine.resume(approved.id);
  const request = store.intakeRequest(approved.intakeRequestId);
  store.saveIntake({ ...request, status: 'queued' }); intake.start();
  await waitUntil(() => store.intakeRequest(request.id).status === 'handoff-complete');
  assert.deepEqual(store.operation(operation.id), operation);
  assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0);
});

test('restricted advance shares the case lock with human approval and cannot execute a payment after a race', async t => {
  const { intake, engine, store, calls } = setup(t);
  const required = await reachReview(intake, engine);
  const results = await Promise.allSettled([
    engine.approve(required.id, approvalInput(required)),
    engine.advanceIntake(required.id, required.intakeRequestId),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'intake_payment_boundary');
  assert.equal(store.operation(engine.getCase(required.id).operationId).status, 'reserved');
  assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0);
});

test('legacy pending operations never reconcile through intake', async t => {
  const { intake, engine, store, calls } = setup(t);
  const saved = intake.submit(payload());
  const item = { ...saved.case, stage: 'payments', status: 'running', operationId: 'legacy-pending' };
  store.saveCase(item);
  store.saveOperation({ id: 'legacy-pending', orderId: item.orderId, lineId: '104-3', issue: 'item_missing', amountMinor: 2000, status: 'pending', submittedAt: new Date().toISOString(), receipt: null });
  const operation = store.operation('legacy-pending'); intake.start();
  await waitUntil(() => store.intakeRequest(saved.request.id).status === 'handoff-complete');
  await assert.rejects(engine.advanceIntake(item.id, saved.request.id), error => error.code === 'intake_payment_boundary');
  assert.deepEqual(store.operation('legacy-pending'), operation); assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0);
});

test('worker errors are explicit and are retried only when requested', async t => {
  let failures = true;
  const local = createProviders({ env: {} });
  let attempts = 0;
  const { intake, engine, calls, store } = setup(t, { overrides: { proposeCase: async input => { attempts++; if (failures) throw new Error('Synthetic analyser failure'); return local.proposeCase(input); } } });
  const saved = intake.submit(payload()); intake.start();
  await waitUntil(() => store.intakeRequest(saved.request.id).status === 'error');
  const failed = engine.getCase(saved.case.id); assert.equal(failed.status, 'error');
  assert.match(intake.list().requests[0].lastError, /No refund was authorised/);
  await delay(20); assert.equal(attempts, 1);
  failures = false; await intake.resume(saved.request.id);
  await waitUntil(() => engine.getCase(saved.case.id).outcome === 'awaiting-approval');
  assert.equal(attempts, 2); assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0);
});

test('a worker step-limit failure stops the case as well as the queue until an explicit retry', async t => {
  const { intake, engine, store, calls } = setup(t);
  const saved = intake.submit(payload());
  await engine.advanceIntake(saved.case.id, saved.request.id);
  store.saveIntake({ ...store.intakeRequest(saved.request.id), status: 'running', attempts: 8 });
  intake.start();
  await waitUntil(() => store.intakeRequest(saved.request.id).status === 'error');
  const failed = engine.getCase(saved.case.id);
  assert.equal(failed.status, 'error'); assert.equal(failed.stage, 'review');
  assert.match(failed.summary, /bounded step allowance/);
  assert.equal(store.intakeRequest(saved.request.id).lastError, failed.summary);
  await delay(20); assert.equal(engine.getCase(failed.id).revision, failed.revision);
  assert.equal(calls.propose, 0); assert.equal(calls.create, 0); assert.equal(calls.retrieve, 0);
  await intake.resume(saved.request.id);
  await waitUntil(() => engine.getCase(saved.case.id).outcome === 'awaiting-approval');
  assert.equal(store.operations(saved.case.orderId).length, 0);
});

test('recording a worker failure preserves a manual pause that wins the case lock', async t => {
  const { intake, engine, store } = setup(t, { overrides: { capabilities: () => ({ analyser: 'openai', payments: 'local' }) } });
  const saved = intake.submit(payload());
  await engine.run(saved.case.id);
  const originalFail = engine.failIntake;
  engine.failIntake = async (...args) => {
    await engine.pause(saved.case.id);
    return originalFail(...args);
  };
  intake.start();
  await waitUntil(() => store.intakeRequest(saved.request.id).status === 'paused');
  const paused = engine.getCase(saved.case.id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.pauseReason, 'manual');
  assert.equal(paused.events.at(-1).label, 'Investigation paused');
  assert.equal(store.intakeRequest(saved.request.id).lastError, undefined);
});

test('intake refuses external analysis and cannot claim ownership of existing unrelated cases', async t => {
  let externalCalls = 0;
  const { intake, engine, store } = setup(t, { overrides: { capabilities: () => ({ analyser: 'openai', payments: 'local' }), proposeCase: async () => { externalCalls++; } } });
  const saved = intake.submit(payload()); intake.start();
  await waitUntil(() => store.intakeRequest(saved.request.id).status === 'error');
  assert.match(store.intakeRequest(saved.request.id).lastError, /local analyser/); assert.equal(externalCalls, 0);
  assert.equal(engine.getCase(saved.case.id).status, 'error');
  await assert.rejects(engine.advanceIntake('missing-item', saved.request.id), error => error.code === 'intake_not_owner');
  await assert.rejects(engine.resumeIntake('missing-item', saved.request.id), error => error.code === 'intake_not_owner');
});

test('malformed intake cannot create partial cases or bypass approval', t => {
  const { intake, store } = setup(t);
  for (const value of [null, [], {}, { ...payload(), eventId: '' }, { ...payload(), eventId: 'bad event id' }, { ...payload(), eventId: 'x'.repeat(121) }, { ...payload(), orderId: 'unknown' }, { ...payload(), complaint: 'short' }, { ...payload(), complaint: 'x'.repeat(4001) }]) assert.throws(() => intake.submit(value), error => error.status === 400);
  assert.equal(store.cases().length, 3); assert.equal(store.intakeRequests().length, 0);
  const saved = intake.submit({ ...payload(), approved: true, stage: 'payments', operationId: 'forged' });
  assert.equal(saved.case.status, 'ready'); assert.equal(saved.case.operationId, undefined); assert.equal(saved.case.approval, undefined);
});

test('HTTP intake supports local create, replay, conflict, listing and readable briefing/report exports', async t => {
  const { intake, engine } = setup(t);
  const server = createApiServer({ engine, intake });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const send = (path, body) => new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:4174', 'Content-Type': 'application/json' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, text, headers: response.headers, body: response.headers['content-type'].includes('application/json') ? JSON.parse(text) : text }); });
    });
    request.on('error', reject); request.end(body === undefined ? '' : JSON.stringify(body));
  });
  const created = await send('/api/intake', payload()); assert.equal(created.status, 201);
  const replay = await send('/api/intake', payload()); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.case.id, created.body.case.id);
  const conflict = await send('/api/intake', { ...payload(), orderId: 'DEMO-107' }); assert.equal(conflict.status, 409);
  const list = await send('/api/intake'); assert.equal(list.body.mode, 'local'); assert.equal(list.body.requests.length, 1);
  const malformed = await send('/api/intake', []); assert.equal(malformed.status, 400);
  const integrations = await send('/api/integrations'); assert.equal(integrations.status, 200); assert.equal(integrations.body.humanApprovalRequired, true);
  const briefing = await send(`/api/cases/${created.body.case.id}/briefing`); assert.equal(briefing.status, 200);
  const board = await send(`/api/cases/${created.body.case.id}/board-export`); assert.equal(board.status, 200); assert.equal(board.body.importReady, false);
  const report = await send(`/api/cases/${created.body.case.id}/report`); assert.equal(report.status, 200); assert.match(report.headers['content-type'], /^text\/markdown/); assert.match(report.text, /Refund Office/); assert.ok(report.headers['content-disposition'].endsWith('-decision-report.md"'));
});
