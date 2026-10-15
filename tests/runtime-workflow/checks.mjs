import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createLocalPostgresRuntime } from '../../server/local-postgres-runtime.mjs';
import { createRuntimeService } from '../../server/runtime-service.mjs';
import { createRuntimeApiServer } from '../../server/runtime-api.mjs';
import { createRuntimeSessions, LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER } from '../../server/runtime-auth.mjs';
import { createProviders } from '../../server/providers.mjs';

// Invoked only by the explicit isolated PostgreSQL harness, never normal tests.
export async function runWorkflowChecks({ ROOT, sql, value, rejected, check, quote }) {
  const tenantId = '50000000-0000-4000-8000-000000000012';
  const pack = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
  const uuid = v => `${quote(v)}::uuid`, text = v => `${quote(v)}::text`, json = v => `${quote(JSON.stringify(v))}::jsonb`;
  const rpc = (name, args) => `select public.refund_runtime_${name}(${[uuid(tenantId), ...args].join(',')});`;
  const reviewerProfile = LOCAL_RUNTIME_PROFILES.find(p => p.role === 'reviewer'), investigatorProfile = LOCAL_RUNTIME_PROFILES.find(p => p.role === 'investigator');
  const actor = profile => ({ role: 'authenticated', userId: profile.userId });
  const principal = profile => ({ ...profile, profileId: profile.id, tenantId });
  const executeSql = async ({ statement, role, userId }) => {
    const result = await sql(statement, { role, userId, allowFailure: true });
    if (result.code !== 0) throw Object.assign(new Error('Local test SQL rejected'), { sqlState: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] });
    const output = result.stdout.trim(); return output ? JSON.parse(output.split('\n').at(-1)) : null;
  };
  const makeRepository = profile => createLocalPostgresRuntime({ executeSql, tenantId, profile });
  const reviewer = makeRepository(reviewerProfile), investigator = makeRepository(investigatorProfile), worker = makeRepository(LOCAL_RUNTIME_WORKER);
  const makeService = () => createRuntimeService({ repositoryForSession: makeRepository, workerRepository: makeRepository(LOCAL_RUNTIME_WORKER), workerDelayMs: 5 });
  const local = createProviders({ env: {} });
  const propose = claim => local.proposeCase({ complaint: claim.case.complaint, order: claim.order, evidence: claim.evidence });
  const note = 'Synthetic rehearsal: inspect the existing saved records; no new evidence or payment is implied.';
  const decision = item => ({ caseId: item.id, expectedRevision: item.revision, expectedFingerprint: item.fingerprint, expectedAmountMinor: item.proposedAmountMinor, note, commandId: randomUUID() });
  const intake = async event => reviewer.enqueueIntake({ eventId: event, orderId: pack.data.orders[0].id, complaint: pack.data.orders[0].sampleComplaint });
  let service;

  await check('office workflow migration adds review and recovery with all payments still disabled', async () => {
    const bytes = readFileSync(join(ROOT, 'integrations/supabase/runtime/002_office_workflow.sql'));
    await sql(bytes.toString('utf8'));
    await sql(`insert into auth.users(id) values ${[...LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER].map(p => `(${uuid(p.userId)})`).join(',')} on conflict do nothing;`);
    await value(rpc('import_dataset', [json(pack.data), text(pack.manifest.digest), json([...LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER].map(p => ({ userId: p.userId, role: p.role })))]));
    for (const name of ['review_case','recover_intake','fail_intake']) {
      const grants = await value(`select jsonb_build_object('anonymous',has_function_privilege('anon',p.oid,'EXECUTE'),'public',coalesce((select bool_or(a.grantee=0 and a.privilege_type='EXECUTE') from aclexplode(p.proacl) a),false),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${text('refund_runtime_'+name)};`);
      assert.deepEqual(grants, { anonymous: false, public: false, authenticated: true });
    }
    return { migrationSha256: createHash('sha256').update(bytes).digest('hex'), newReviewAndRecoveryRPCs: 3, paymentSubmission: false };
  });

  await check('the real application background service investigates all 12 cases without a browser or payment', async () => {
    service = makeService(); service.start();
    let workspace;
    const deadline = Date.now() + 30000;
    do { workspace = await reviewer.readWorkspace(); if (workspace.intakeRequests.every(r => !['queued','running'].includes(r.status))) break; assert.equal(service.workerState().lastError, null); await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
    await service.close();
    assert.ok(workspace.intakeRequests.every(r => !['queued','running'].includes(r.status)));
    for (const scenario of pack.data.scenarios) { const item = workspace.cases.find(c => c.id === scenario.caseId); assert.equal(item.outcome, scenario.expectedOutcome); assert.equal(item.proposedAmountMinor, scenario.expectedAmountMinor); assert.equal(item.approval, null); }
    const count = await value(`select count(*)::integer from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded;`); assert.equal(count, 0);
    const restart = makeService(); const saved = await restart.bootstrap(principal(reviewerProfile)); await restart.close();
    assert.equal(saved.capabilities.networkMode, 'offline'); assert.equal(saved.capabilities.paymentSubmission, false);
    assert.equal(saved.cases.filter(c => c.approval?.state === 'required').length, 6);
    return { exactOutcomes: 12, backgroundActor: LOCAL_RUNTIME_WORKER.userId, newOperations: 0, preservedAcrossServiceRestart: true };
  });

  await check('recorded review holds require explicit reviewer reopening before investigator recovery', async () => {
    const item = (await reviewer.readWorkspace()).cases.find(c => c.outcome === 'awaiting-approval');
    const commandId = randomUUID(), input = { caseId: item.id, expectedRevision: item.revision, action: 'request-evidence', note, commandId };
    const held = await reviewer.reviewCase(input); assert.equal(held.review.state, 'awaiting-evidence'); assert.equal(held.fingerprint, null);
    assert.equal((await reviewer.reviewCase(input)).revision, held.revision);
    await assert.rejects(reviewer.reviewCase({ ...input, note: note + ' changed' }), e => e.code === 'runtime_conflict');
    await rejected(rpc('review_case', [text(item.id), `${held.revision}::bigint`, text('reopen'), text(note), uuid(randomUUID())]), actor(investigatorProfile), /42501/);
    await assert.rejects(investigator.recoverIntake({ requestId: held.intakeRequestId, expectedRevision: held.revision, note, commandId: randomUUID() }), e => e.code === 'runtime_conflict');
    const reopened = await reviewer.reviewCase({ caseId: held.id, expectedRevision: held.revision, action: 'reopen', note, commandId: randomUUID() });
    const recovery = { requestId: reopened.intakeRequestId, expectedRevision: reopened.revision, note, commandId: randomUUID() };
    const queued = await investigator.recoverIntake(recovery); assert.equal(queued.case.status, 'ready'); assert.equal(queued.case.review, null); assert.equal(queued.request.status, 'queued');
    assert.equal((await investigator.recoverIntake(recovery)).replayed, true);
    assert.ok(queued.case.events.some(e => e.type === 'intake.recovered' && e.payload.previousInvestigation.review.state === 'reopened' && e.payload.previousInvestigation.evidence.length));
    const claim = await worker.claimIntake(); const finished = await worker.finishIntake({ requestId: claim.requestId, fence: claim.fence, proposal: await propose(claim) });
    assert.equal(finished.case.outcome, 'awaiting-approval'); assert.equal(finished.case.review, null); assert.equal(finished.case.approval, null);
    return { reviewCommandReplay: true, evidenceHoldCannotBeSilentlyCleared: true, previousFactsPreserved: true, freshApprovalRequired: true };
  });

  await check('closing and reopening preserves actor/history and stale revisions cannot decide', async () => {
    const item = (await reviewer.readWorkspace()).cases.find(c => c.outcome === 'held');
    await rejected(rpc('review_case', [text(item.id), `${item.revision}::bigint`, text('reopen'), text(note), uuid(randomUUID())]), actor(reviewerProfile), /55000/);
    const closed = await reviewer.reviewCase({ caseId: item.id, expectedRevision: item.revision, action: 'close-no-refund', note, commandId: randomUUID() });
    assert.equal(closed.outcome, 'closed-no-refund'); assert.equal(closed.review.actor, reviewerProfile.userId);
    await assert.rejects(reviewer.reviewCase({ caseId: item.id, expectedRevision: item.revision, action: 'reopen', note, commandId: randomUUID() }), e => e.code === 'runtime_conflict');
    const reopened = await reviewer.reviewCase({ caseId: item.id, expectedRevision: closed.revision, action: 'reopen', note, commandId: randomUUID() });
    assert.equal(reopened.outcome, 'held'); assert.equal(reopened.approval, null); assert.ok(reopened.events.length > item.events.length);
    return { closeAndReopenRecorded: true, staleReviewRejected: true, paymentAuthorised: false };
  });

  await check('failed claims stop visibly and explicit recovery fences out stale and different actors', async () => {
    await intake('workflow-failure'); const claim = await worker.claimIntake();
    await rejected(rpc('fail_intake', [text(claim.requestId), `${claim.fence}::bigint`, text('local_test_failure')]), actor(investigatorProfile), /40001/);
    await rejected(rpc('fail_intake', [text(claim.requestId), `${claim.fence}::bigint`, text('local_test_failure')]), actor(reviewerProfile), /42501/);
    const stopped = await worker.failIntake({ requestId: claim.requestId, fence: claim.fence, errorCode: 'local_test_failure' });
    assert.equal(stopped.request.status, 'error'); assert.equal(stopped.case.status, 'paused');
    const recovered = await investigator.recoverIntake({ requestId: stopped.request.id, expectedRevision: stopped.case.revision, note, commandId: randomUUID() });
    assert.ok(recovered.request.fence > claim.fence);
    await rejected(rpc('finish_intake', [text(claim.requestId), `${claim.fence}::bigint`, json(await propose(claim))]), actor(LOCAL_RUNTIME_WORKER), /40001/);
    const next = await investigator.claimIntake(); assert.equal(next.requestId, claim.requestId);
    await investigator.finishIntake({ requestId: next.requestId, fence: next.fence, proposal: await propose(next) });
    return { failedCaseAndQueueAgree: true, roleIsolation: true, oldFenceRejected: true, recoveryRecorded: true };
  });

  await check('durable claims survive worker restart and eight expired attempts require explicit recovery', async () => {
    await intake('workflow-exhausted'); let claim;
    for (let i = 0; i < 8; i++) {
      claim = await makeRepository(LOCAL_RUNTIME_WORKER).claimIntake(); assert.ok(claim);
      await sql(`update refund_runtime.intake_requests set lease_until=clock_timestamp()-interval '1 second' where tenant_id=${uuid(tenantId)} and id=${text(claim.requestId)};`);
    }
    assert.equal(await worker.claimIntake(), null);
    const stopped = await reviewer.readCase(claim.caseId); assert.equal(stopped.status, 'paused'); assert.equal(stopped.outcome, 'held');
    const savedRequest = (await reviewer.readWorkspace()).intakeRequests.find(r => r.id === claim.requestId); assert.equal(savedRequest.status, 'error'); assert.equal(savedRequest.attempts, 8);
    const recovered = await investigator.recoverIntake({ requestId: claim.requestId, expectedRevision: stopped.revision, note, commandId: randomUUID() });
    assert.equal(recovered.request.attempts, 0);
    const next = await makeRepository(LOCAL_RUNTIME_WORKER).claimIntake(); assert.ok(next.fence > claim.fence);
    await worker.finishIntake({ requestId: next.requestId, fence: next.fence, proposal: await propose(next) });
    return { restartSafeClaims: true, attemptsBeforeStop: 8, explicitRecoveryResetsAttempts: true };
  });

  await check('the actual HTTP API uses opaque local sessions and records one disabled reservation with report readback', async () => {
    const auth = createRuntimeSessions({ tenantId }); const liveService = makeService();
    const server = createRuntimeApiServer({ service: liveService, auth }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, { method = 'GET', body, cookie, origin = 'http://127.0.0.1:4273' } = {}) => new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: { Host: '127.0.0.1:4274', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }) } }, response => { const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }); }); }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      assert.equal((await request('/api/bootstrap')).status, 401);
      assert.equal((await request('/api/session', { method: 'POST', body: { profileId: 'reviewer' }, origin: null })).status, 403);
      const login = await request('/api/session', { method: 'POST', body: { profileId: 'reviewer' } }); assert.equal(login.status, 200);
      const cookie = login.headers['set-cookie'][0].split(';')[0]; assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
      const bootstrap = (await request('/api/bootstrap', { cookie })).json(); assert.equal(bootstrap.capabilities.paymentSubmission, false);
      const item = bootstrap.cases.find(c => c.status === 'review' && c.approval?.state === 'required'); assert.ok(item);
      const input = { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor, fingerprint: item.approval.fingerprint, note, commandId: randomUUID() };
      const approvedResponse = await request(`/api/cases/${item.id}/approve`, { method: 'POST', body: input, cookie }); assert.equal(approvedResponse.status, 200, approvedResponse.text);
      const reserved = approvedResponse.json(); assert.equal(reserved.status, 'reserved'); assert.equal(reserved.receipt, null); assert.match(reserved.summary, /not paid/);
      const replay = await request(`/api/cases/${item.id}/approve`, { method: 'POST', body: input, cookie }); assert.equal(replay.status, 200); assert.equal(replay.json().operationId, reserved.operationId);
      assert.equal((await request('/api/worker/run-next', { method: 'POST', body: {}, cookie })).status, 403);
      assert.equal((await request(`/api/cases/${item.id}/advance`, { method: 'POST', body: {}, cookie })).status, 404);
      const report = await request(`/api/cases/${item.id}/report`, { cookie }); assert.equal(report.status, 200); assert.match(report.text, /Reserved only\. Not submitted and not paid/);
      const saved = await reviewer.readCase(item.id); assert.equal(saved.approval.actor, reviewerProfile.userId); assert.equal(saved.operationId, reserved.operationId);
      await assert.rejects(reviewer.reviewCase({ caseId: item.id, expectedRevision: saved.revision, action: 'close-no-refund', note, commandId: randomUUID() }), e => e.code === 'runtime_conflict');
      await request('/api/session', { method: 'DELETE', body: {}, cookie }); assert.equal((await request('/api/bootstrap', { cookie })).status, 401);
      const operations = await value(`select jsonb_agg(jsonb_build_object('status',status,'submissionEnabled',submission_enabled,'seeded',seeded)) from refund_runtime.operations where tenant_id=${uuid(tenantId)};`);
      assert.equal(operations.filter(o => !o.seeded).length, 1); assert.ok(operations.every(o => !o.submissionEnabled));
      return { opaqueSession: true, authenticatedReadback: true, idempotentReservation: true, reportDownloaded: true, newReservations: 1, paymentsSubmitted: 0 };
    } finally { await liveService.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auth.close(); }
  });
}
