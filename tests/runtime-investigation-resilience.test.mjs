import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createProviders } from '../server/providers.mjs';
import { createLocalObserver } from '../server/observability.mjs';

const tenantId = '72000000-0000-4000-8000-000000000001';
const investigator = { tenantId, userId: '72000000-0000-4000-8000-000000000002', role: 'investigator' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'The isolated queue did not reach the expected state.'); await pause(2); }
}
function fixture(options = {}) {
  const calls = [], rows = [1, 2].map(number => {
    const order = { id: `QUEUE-O${number}`, totalMinor: 2000, lines: [{ id: `QUEUE-L${number}`, name: 'Travel mug', ordered: 1, packed: 0, unitAmountMinor: 2000 }], delivery: { disputed: false } };
    const item = { id: `QUEUE-C${number}`, caseId: `RF-${number}`, orderId: order.id, revision: 1, complaint: 'The travel mug is missing.', title: 'Synthetic missing mug', status: 'ready', stage: 'reception', outcome: null, fingerprint: null, proposedAmountMinor: 0, approval: null, operationId: null, receipt: null, evidence: [{ id: `order:${order.id}` }, { id: `packing:${order.id}` }], checks: [], events: [], intakeManaged: true, intakeRequestId: `QUEUE-R${number}` };
    return { order, item, request: { id: item.intakeRequestId, caseId: item.id, orderId: order.id, status: 'queued', fence: 0, attempts: 0 } };
  });
  const saved = row => structuredClone({ case: row.item, request: row.request });
  const workspace = () => structuredClone({ tenantId, mode: 'synthetic-only', paymentsEnabled: false, orders: rows.map(row => row.order), cases: rows.map(row => row.item), intakeRequests: rows.map(row => row.request), policy: { version: 1, limitMinor: 2500 } });
  const repo = {
    async claimIntake() {
      calls.push('claim'); if (options.claimError) throw options.claimError;
      const row = rows.find(row => row.request.status === 'queued'); if (!row) return null;
      row.request.status = 'running'; row.request.fence++; row.request.attempts++; row.request.leaseUntil = new Date(Date.now() + 30000).toISOString();
      row.item = { ...row.item, status: 'running', stage: 'policy', revision: row.item.revision + 1 };
      calls.push(['claimed', row.item.id]);
      if (options.claimGate) await options.claimGate;
      return structuredClone({ requestId: row.request.id, caseId: row.item.id, fence: row.request.fence, leaseUntil: row.request.leaseUntil, case: row.item, order: row.order, evidence: row.item.evidence, policy: { version: 1, limitMinor: 2500 } });
    },
    async finishIntake({ requestId, proposal }) {
      calls.push(['finish', requestId]); if (options.finishError) throw options.finishError;
      const row = rows.find(row => row.request.id === requestId);
      row.item = { ...row.item, revision: row.item.revision + 1, status: 'paused', stage: 'review', outcome: 'awaiting-approval', fingerprint: 'a'.repeat(64), proposal, proposedAmountMinor: proposal.amountMinor };
      row.request.status = 'awaiting-approval'; delete row.request.leaseUntil;
      return saved(row);
    },
    async failIntake({ requestId, fence, errorCode }) {
      calls.push(['fail', requestId, fence, errorCode]);
      if (options.failError) throw options.failError;
      const row = rows.find(row => row.request.id === requestId);
      row.request.status = 'error'; row.request.lastError = errorCode; delete row.request.leaseUntil;
      row.item = { ...row.item, revision: row.item.revision + 1, status: 'paused', stage: 'review', outcome: 'held', fingerprint: null, events: [...row.item.events, { type: 'intake.failed', actor: investigator.userId, payload: { fence, errorCode } }] };
      if (options.failLostResponse) throw Object.assign(new Error('PRIVATE lost write response'), { code: 'runtime_transport_unresolved', uncertain: true });
      return saved(row);
    },
    async readWorkspace() {
      calls.push('read'); if (options.readError) throw options.readError;
      const value = workspace(); return options.alterRead ? options.alterRead(value) : value;
    },
    async recoverIntake({ requestId }) {
      const row = rows.find(row => row.request.id === requestId); calls.push(['recover', requestId]);
      row.request.status = 'queued'; row.request.fence++; delete row.request.lastError;
      row.item = { ...row.item, revision: row.item.revision + 1, status: 'ready', stage: 'reception', outcome: null };
      return saved(row);
    },
  };
  const local = createProviders({ env: {} });
  let bad = options.bad !== false;
  const providers = { capabilities: local.capabilities, async proposeCase(input) {
    calls.push(['propose', input.order.id]);
    if (input.order.id === rows[0].order.id && bad) {
      if (options.proposalError) throw options.proposalError;
      return { ...await local.proposeCase(input), evidenceIds: ['invented-evidence'] };
    }
    return local.proposeCase(input);
  } };
  const makeService = () => createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, workerDelayMs: 2, automaticWorker: options.automaticWorker ?? true, investigationProviders: providers, observer: options.observer });
  return { rows, calls, repo, makeService, service: makeService(), fixProposal() { bad = false; } };
}

test('automatic investigation holds a verified case-local failure and continues unrelated work without retrying the failed case', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.service.start();
  await until(() => f.rows[1].request.status === 'awaiting-approval'); await pause(20);
  assert.equal(f.rows[0].request.status, 'error'); assert.equal(f.rows[0].item.outcome, 'held');
  assert.equal(f.rows[0].request.attempts, 1); assert.equal(f.rows[1].request.attempts, 1);
  assert.ok(f.calls.indexOf('read') > f.calls.findIndex(call => Array.isArray(call) && call[0] === 'fail'));
  assert.equal(f.service.workerState().enabled, true); assert.equal(f.service.workerState().completed, 1); assert.equal(f.service.workerState().failed, 1);
  assert.deepEqual(f.service.workerState().lastFailure, { caseId: 'QUEUE-C1', code: 'invalid_investigation_proposal', safelyHeld: true });
  assert.ok(f.rows.every(row => row.item.approval === null && row.item.operationId === null && row.item.receipt === null));
});

test('manual investigation preserves its exact error while separately confirming a durable hold', async t => {
  const original = Object.assign(new Error('PRIVATE invalid case response'), { code: 'invalid_proposal' });
  const f = fixture({ proposalError: original, automaticWorker: false }); t.after(() => f.service.close());
  await assert.rejects(f.service.runNext(investigator), error => error === original);
  assert.equal(f.rows[0].request.status, 'error'); assert.equal(f.rows[1].request.status, 'queued');
  assert.equal(f.service.workerState().lastFailure.safelyHeld, true);
  assert.doesNotMatch(JSON.stringify(f.service.workerState()), /PRIVATE/);
});

for (const [label, options] of [
  ['lost claim response', { claimError: Object.assign(new Error('PRIVATE'), { code: 'runtime_transport_unresolved', uncertain: true }) }],
  ['lost finish response', { bad: false, finishError: Object.assign(new Error('PRIVATE'), { code: 'runtime_transport_unresolved', uncertain: true }) }],
  ['changed finish fence', { bad: false, finishError: Object.assign(new Error('PRIVATE'), { code: 'runtime_conflict' }) }],
  ['proposal-looking code from a database write', { bad: false, finishError: Object.assign(new Error('PRIVATE'), { code: 'invalid_proposal' }) }],
  ['access denial', { proposalError: Object.assign(new Error('PRIVATE'), { code: 'runtime_access_denied' }) }],
  ['provider authentication failure', { proposalError: Object.assign(new Error('PRIVATE'), { code: 'openai_http_401' }) }],
  ['unknown proposal failure', { proposalError: new Error('PRIVATE') }],
  ['uncertain proposal failure', { proposalError: Object.assign(new Error('PRIVATE'), { code: 'invalid_proposal', uncertain: true }) }],
  ['access status on a proposal-looking error', { proposalError: Object.assign(new Error('PRIVATE'), { code: 'invalid_proposal', status: 403 }) }],
  ['lost failure response after commit', { failLostResponse: true }],
  ['failure ownership conflict', { failError: Object.assign(new Error('PRIVATE'), { code: 'runtime_conflict' }) }],
  ['failed independent read', { readError: Object.assign(new Error('PRIVATE'), { code: 'runtime_access_denied' }) }],
]) test(`${label} stops the entire worker and leaves unrelated queued work untouched`, async t => {
  const f = fixture(options); t.after(() => f.service.close()); f.service.start();
  await until(() => f.service.workerState().enabled === false); await pause(10);
  assert.equal(f.rows[1].request.status, 'queued'); assert.equal(f.rows[1].request.attempts, 0);
  assert.equal(f.service.workerState().lastFailure.safelyHeld, false);
  assert.doesNotMatch(JSON.stringify(f.service.workerState()), /PRIVATE/);
});

for (const [label, change] of [
  ['another fence', value => { value.intakeRequests[0].fence++; }],
  ['another case', value => { value.intakeRequests[0].caseId = 'OTHER'; }],
  ['another error', value => { value.intakeRequests[0].lastError = 'different_error'; }],
  ['active lease', value => { value.intakeRequests[0].leaseUntil = new Date(Date.now() + 30000).toISOString(); }],
  ['wrong revision', value => { value.cases[0].revision++; }],
  ['missing failure event', value => { value.cases[0].events = []; }],
  ['another event fence', value => { value.cases[0].events[0].payload.fence++; }],
  ['approval present', value => { value.cases[0].approval = { state: 'approved' }; }],
  ['payment operation present', value => { value.cases[0].operationId = 'unexpected'; }],
  ['receipt present', value => { value.cases[0].receipt = { id: 'unexpected' }; }],
  ['changed evidence', value => { value.cases[0].evidence = []; }],
  ['request still running', value => { value.intakeRequests[0].status = 'running'; }],
  ['an active case', value => { value.cases[0].status = 'running'; }],
  ['payment-enabled workspace', value => { value.paymentsEnabled = true; }],
]) test(`a failure acknowledgement alone cannot resume the queue when independent saved state has ${label}`, async t => {
  const f = fixture({ alterRead(value) { change(value); return value; } }); t.after(() => f.service.close()); f.service.start();
  await until(() => !f.service.workerState().enabled);
  assert.equal(f.rows[0].request.status, 'error'); assert.equal(f.rows[1].request.status, 'queued');
  assert.equal(f.service.workerState().lastFailure.safelyHeld, false);
});

for (const code of ['invalid_proposal', 'analysis_refused']) test(`an explicit ${code} proposal failure can be held while the next case proceeds`, async t => {
  const f = fixture({ proposalError: Object.assign(new Error('PRIVATE'), { code }) }); t.after(() => f.service.close()); f.service.start();
  await until(() => f.rows[1].request.status === 'awaiting-approval');
  assert.equal(f.rows[0].request.status, 'error'); assert.equal(f.rows[0].request.lastError, code);
  assert.equal(f.rows[0].request.attempts, 1); assert.equal(f.service.workerState().enabled, true);
});

test('restart continues untouched work but requires an explicit investigator recovery to retry a held failure', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.service.runNext(investigator)); await f.service.close();
  const replacement = f.makeService(); t.after(() => replacement.close()); replacement.start();
  await until(() => f.rows[1].request.status === 'awaiting-approval');
  assert.equal(f.rows[0].request.attempts, 1); assert.equal(f.rows[0].request.status, 'error');
  f.fixProposal();
  await replacement.resume(investigator, f.rows[0].request.id, { expectedRevision: f.rows[0].item.revision, note: 'Inspected the held case and corrected the local fixture.', commandId: randomUUID() });
  await until(() => f.rows[0].request.status === 'awaiting-approval');
  assert.equal(f.rows[0].request.attempts, 2); assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'recover').length, 1);
});

test('automatic recovery scheduling cannot overlap a manual claim', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ claimGate: gate }); t.after(() => f.service.close());
  const manual = f.service.runNext(investigator); await until(() => f.calls.some(call => Array.isArray(call) && call[0] === 'claimed'));
  f.service.start(); await pause(20); assert.equal(f.calls.filter(call => call === 'claim').length, 1);
  release(); await assert.rejects(manual);
  await until(() => f.rows[1].request.status === 'awaiting-approval');
  assert.ok(f.rows.every(row => row.request.attempts === 1));
});

test('a manual fatal failure also cancels an already waiting automatic timer', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const original = Object.assign(new Error('PRIVATE'), { code: 'runtime_access_denied' });
  const f = fixture({ claimGate: gate, proposalError: original }); t.after(() => f.service.close());
  const manual = f.service.runNext(investigator); await until(() => f.calls.some(call => Array.isArray(call) && call[0] === 'claimed'));
  f.service.start(); await pause(20); release(); await assert.rejects(manual, error => error === original); await pause(70);
  assert.equal(f.service.workerState().enabled, false); assert.equal(f.calls.filter(call => call === 'claim').length, 1);
  assert.equal(f.rows[1].request.status, 'queued');
});

test('failure tracing remains an error and records hold confirmation before the next successful case', async t => {
  const observer = createLocalObserver(), f = fixture({ observer }); t.after(() => f.service.close()); f.service.start();
  await until(() => f.rows[1].request.status === 'awaiting-approval'); await observer.flush();
  const spans = observer.snapshot().spans, investigations = spans.filter(span => span.name === 'refund.investigation');
  assert.equal(investigations.length, 2); assert.equal(investigations[0].status, 'ERROR'); assert.equal(investigations[1].status, 'OK');
  assert.equal(investigations[0].attributes.outcome, 'held');
  assert.equal(spans.find(span => span.name === 'refund.investigation.verify-hold').status, 'OK');
  assert.equal(spans.find(span => span.name === 'refund.investigation.hold').attributes.action, 'hold');
  assert.equal(spans.find(span => span.name === 'refund.investigation.verify-hold').attributes.action, 'verify-hold');
  // Inspect recorded metadata rather than matching identifier prefixes against
  // unrelated random trace IDs or numeric timestamps.
  const metadata = JSON.stringify(spans.map(({ name, attributes }) => ({ name, attributes })));
  const privateValues = [tenantId, investigator.userId, 'invented-evidence', ...f.rows.flatMap(row => [row.item.id, row.request.id, row.order.id, row.item.complaint, ...row.item.evidence.map(entry => entry.id)])];
  for (const value of privateValues) assert.ok(!metadata.includes(JSON.stringify(value)), 'Private fixture data must not enter trace names or attributes.');
  assert.doesNotMatch(metadata, /PRIVATE/);
});

test('a broken recorder cannot repeat the hold or substitute success for failed independent readback', async t => {
  for (const suppress of [false, true]) {
    const observer = { async span(name, _attributes, callback) {
      if (!name.endsWith('verify-hold')) return callback();
      try { return await callback(); } catch (error) { if (suppress) return { case: { outcome: 'held' } }; throw new Error('PRIVATE replacement'); }
    } };
    const f = fixture({ observer, readError: new Error('PRIVATE lost readback') }); t.after(() => f.service.close()); f.service.start();
    await until(() => !f.service.workerState().enabled);
    assert.equal(f.rows[1].request.status, 'queued'); assert.equal(f.service.workerState().lastFailure.safelyHeld, false);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'fail').length, 1);
    assert.equal(f.calls.filter(call => call === 'read').length, 1);
  }
});
