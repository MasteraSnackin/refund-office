import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createProviders } from '../../server/providers.mjs';
import { createSupabaseRuntimeRepository } from '../../server/supabase-runtime-repository.mjs';

// This module is only invoked by the explicit local PostgreSQL harness. Normal
// npm tests never start Docker. All identities and decisions below are isolated
// test fixtures; they do not approve any case in the running application.
export async function runSchemaChecks({ ROOT, sql, value, rejected, check, quote }) {
  const json = entry => `${quote(JSON.stringify(entry))}::jsonb`;
  const uuid = entry => `${quote(entry)}::uuid`;
  const text = entry => `${quote(entry)}::text`;
  const int = entry => `${Number(entry)}::bigint`;
  const rpc = (name, args) => `select public.refund_runtime_${name}(${args.join(',')});`;
  const ids = {
    reviewer1: '10000000-0000-4000-8000-000000000001',
    worker1: '10000000-0000-4000-8000-000000000002',
    worker1b: '10000000-0000-4000-8000-000000000003',
    reviewer2: '20000000-0000-4000-8000-000000000001',
    worker2: '20000000-0000-4000-8000-000000000002',
    outsider: '30000000-0000-4000-8000-000000000001',
  };
  const actor = userId => ({ role: 'authenticated', userId });
  const pack1 = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
  const pack2 = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/busy-50.json'), 'utf8')));
  const packs = [pack1, pack2];
  const readWorkspace = (pack, userId) => value(rpc('read_workspace', [uuid(pack.tenantId)]), actor(userId));
  const readCase = (pack, caseId, userId = ids.reviewer1) => value(rpc('read_case', [uuid(pack.tenantId), text(caseId)]), actor(userId));
  const claim = (pack, userId, seconds = 30) => value(rpc('claim_intake', [uuid(pack.tenantId), `${seconds}::integer`]), actor(userId));
  const local = createProviders({ env: {}, fetchImpl: () => { throw new Error('A verification test attempted an external request.'); } });
  const propose = job => local.proposeCase({ complaint: job.case.complaint, order: job.order, evidence: job.evidence });
  const finishSql = (pack, job, proposal) => rpc('finish_intake', [uuid(pack.tenantId), text(job.requestId), int(job.fence), json(proposal)]);
  const finish = async (pack, job, userId, proposal) => value(finishSql(pack, job, proposal || await propose(job)), actor(userId));
  const enqueue = (pack, eventId, order = pack.data.orders[0]) => rpc('enqueue_intake', [uuid(pack.tenantId), text(eventId), text(order.id), text(order.sampleComplaint)]);
  const importSql = (pack, members = []) => rpc('import_dataset', [uuid(pack.tenantId), json(pack.data), text(pack.manifest.digest), json(members)]);

  await check('the operational migration executes in PostgreSQL and exposes only the documented RPCs', async () => {
    const bytes = readFileSync(join(ROOT, 'integrations/supabase/runtime/001_runtime.sql'));
    await sql(bytes.toString('utf8'));
    const rows = await value("select jsonb_agg(jsonb_build_object('name',p.proname,'definer',p.prosecdef,'config',p.proconfig) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'refund_runtime_%';");
    const names = ['import_dataset', 'read_workspace', 'read_case', 'enqueue_intake', 'claim_intake', 'finish_intake', 'approve_and_reserve'].map(name => 'refund_runtime_' + name).sort();
    assert.deepEqual(rows.map(row => row.name), names);
    for (const row of rows) { assert.equal(row.definer, true); assert.ok(row.config?.some(item => item === 'search_path=""' || item === 'search_path=')); }
    return { migrationSha256: createHash('sha256').update(bytes).digest('hex'), rpcCount: rows.length };
  });

  await check('both exact generated import scripts create fresh synthetic workspaces with no members', async () => {
    const results = [];
    for (const pack of packs) {
      const result = await value(pack.sql);
      assert.equal(result.tenantId, pack.tenantId);
      assert.equal(result.caseCount, pack.data.cases.length);
      assert.equal(result.orderCount, pack.data.orders.length);
      assert.equal(result.replayed, false);
      await rejected(rpc('read_workspace', [uuid(pack.tenantId)]), actor(ids.reviewer1), /42501/);
      results.push({ datasetId: pack.datasetId, cases: result.caseCount, orders: result.orderCount, membersCreated: 0 });
    }
    return results;
  });

  await check('dataset retries preserve state and privileged import rejects changed catalogues and browser callers', async () => {
    const replay = await value(pack1.sql, { role: 'service_role' });
    assert.equal(replay.replayed, true);
    await rejected(importSql(pack1), { role: 'anon' }, /42501/);
    await rejected(importSql(pack1), actor(ids.reviewer1), /42501/);
    const changed = structuredClone(pack1.data); changed.title += ' changed';
    const changedPack = prepareSyntheticImport(changed);
    await rejected(importSql(changedPack), {}, /23505/);
    await rejected(rpc('import_dataset', [uuid(pack1.tenantId), json(pack1.data), text('0'.repeat(64)), json([])]), {}, /22023/);
    return { exactReplay: true, changedCatalogueRejected: true, unprivilegedImportDenied: true };
  });

  // Membership and private-table mutation fixtures are added after the schema
  // has been applied. They operate only in the harness's disposable database.
  await sql(`insert into auth.users(id) values ${Object.values(ids).map(id => `(${uuid(id)})`).join(',')};`);
  await configureTestMembers({ sql, quote, ids, pack1, pack2 });

  await check('fresh imports preserve historical remedies without approvals or executable payments', async () => {
    const results = [];
    for (const [pack, reviewer] of [[pack1, ids.reviewer1], [pack2, ids.reviewer2]]) {
      const workspace = await readWorkspace(pack, reviewer);
      assert.equal(workspace.mode, 'synthetic-only');
      assert.equal(workspace.paymentsEnabled, false);
      assert.equal(workspace.cases.length, pack.data.cases.length);
      assert.equal(workspace.orders.length, pack.data.orders.length);
      assert.equal(workspace.intakeRequests.length, pack.data.cases.length);
      assert.ok(workspace.cases.every(item => !item.approval && !item.receipt && item.status === 'ready'));
      assert.ok(workspace.intakeRequests.every(item => item.status === 'queued'));
      results.push({ datasetId: pack.datasetId, freshCases: workspace.cases.length, queued: workspace.intakeRequests.length, paymentsEnabled: workspace.paymentsEnabled });
    }
    return results;
  });

  await check('anonymous users and cross-tenant members cannot read or enqueue work', async () => {
    await rejected(rpc('read_workspace', [uuid(pack1.tenantId)]), { role: 'anon' }, /42501/);
    await rejected(rpc('read_workspace', [uuid(pack1.tenantId)]), { role: 'authenticated' }, /42501/);
    await rejected(rpc('read_workspace', [uuid(pack1.tenantId)]), { ...actor(ids.reviewer1), anonymous: true }, /42501/);
    await rejected(rpc('read_workspace', [uuid(pack1.tenantId)]), actor(ids.outsider), /42501/);
    await rejected(rpc('read_workspace', [uuid(pack2.tenantId)]), actor(ids.reviewer1), /42501/);
    await rejected(rpc('read_case', [uuid(pack2.tenantId), text(pack2.data.cases[0].id)]), actor(ids.reviewer1), /42501/);
    await rejected(enqueue(pack2, 'cross-tenant-request'), actor(ids.reviewer1), /42501/);
    await rejected(enqueue(pack1, 'cross-tenant-order', pack2.data.orders[0]), actor(ids.reviewer1));
    return { anonymous: 'denied', missingIdentity: 'denied', outsider: 'denied', crossTenantRead: 'denied', crossTenantWrite: 'denied' };
  });

  await check('browser and service roles have no direct private-table writes and row policies isolate reads', async () => {
    return checkPrivateTables({ sql, value, rejected, quote, ids, pack1, pack2 });
  });

  await check('reviewers cannot claim or finish investigation work', async () => {
    await rejected(rpc('claim_intake', [uuid(pack1.tenantId), '30']), actor(ids.reviewer1), /42501/);
    await rejected(rpc('finish_intake', [uuid(pack1.tenantId), text('nonexistent'), '1', json({})]), actor(ids.reviewer1), /42501/);
    return { claim: 'denied', finish: 'denied' };
  });

  await check('two concurrent investigator sessions claim different requests without duplicating ownership', async () => {
    const jobs = await Promise.all([claim(pack1, ids.worker1), claim(pack1, ids.worker1b)]);
    assert.ok(jobs[0] && jobs[1]);
    assert.notEqual(jobs[0].requestId, jobs[1].requestId);
    assert.notEqual(jobs[0].caseId, jobs[1].caseId);
    await finish(pack1, jobs[0], ids.worker1);
    await finish(pack1, jobs[1], ids.worker1b);
    return { distinctRequests: jobs.map(job => job.requestId), fences: jobs.map(job => job.fence) };
  });

  await check('the database independently evaluates all 62 synthetic cases against the expected outcomes', async () => {
    const results = [];
    for (const [pack, worker, reviewer] of [[pack1, ids.worker1, ids.reviewer1], [pack2, ids.worker2, ids.reviewer2]]) {
      for (let n = 0; n <= pack.data.cases.length; n++) {
        const job = await claim(pack, worker);
        if (!job) break;
        await finish(pack, job, worker);
        assert.ok(n < pack.data.cases.length, 'The queue returned more jobs than imported cases.');
      }
      const workspace = await readWorkspace(pack, reviewer);
      const counts = {};
      for (const scenario of pack.data.scenarios) {
        const item = workspace.cases.find(entry => entry.id === scenario.caseId);
        assert.ok(item, `Missing case ${scenario.caseId}`);
        assert.equal(item.outcome, scenario.expectedOutcome, `Unexpected outcome for ${scenario.caseId}`);
        assert.equal(item.proposedAmountMinor, scenario.expectedAmountMinor, `Unexpected amount for ${scenario.caseId}`);
        assert.ok(!item.approval, 'Investigation must not approve a refund.');
        counts[item.outcome] = (counts[item.outcome] || 0) + 1;
      }
      assert.ok(workspace.intakeRequests.every(item => !['queued', 'running'].includes(item.status)));
      results.push({ datasetId: pack.datasetId, checked: workspace.cases.length, outcomes: counts, newApprovals: 0 });
    }
    return results;
  });

  await runTransitionChecks({ sql, value, rejected, check, quote, json, uuid, text, int, rpc, ids, actor, packs, pack1, pack2, readWorkspace, readCase, claim, propose, finishSql, finish, enqueue });
}

async function configureTestMembers({ sql, quote, ids, pack1, pack2 }) {
  const members = [[pack1.tenantId, ids.reviewer1, 'reviewer'], [pack1.tenantId, ids.worker1, 'investigator'],
    [pack1.tenantId, ids.worker1b, 'investigator'], [pack2.tenantId, ids.reviewer2, 'reviewer'], [pack2.tenantId, ids.worker2, 'investigator']];
  await sql(`insert into refund_runtime.memberships(tenant_id,user_id,role) values ${members.map(row => `(${row.map(quote).join(',')})`).join(',')};`);
}

async function checkPrivateTables({ sql, value, rejected, quote, ids, pack1, pack2 }) {
  const privileges = await value("select jsonb_agg(jsonb_build_object('role',r.name,'table',t.table_name,'insert',has_table_privilege(r.name,format('%I.%I',t.table_schema,t.table_name),'INSERT'),'update',has_table_privilege(r.name,format('%I.%I',t.table_schema,t.table_name),'UPDATE'),'delete',has_table_privilege(r.name,format('%I.%I',t.table_schema,t.table_name),'DELETE')) order by r.name,t.table_name) from information_schema.tables t cross join (values ('anon'),('authenticated'),('service_role')) r(name) where t.table_schema='refund_runtime' and t.table_type='BASE TABLE';");
  assert.ok(privileges.length >= 15);
  assert.ok(privileges.every(entry => !entry.insert && !entry.update && !entry.delete));
  const owned = await value(`select coalesce(jsonb_agg(distinct tenant_id),'[]'::jsonb) from refund_runtime.cases;`, { role: 'authenticated', userId: ids.reviewer1 });
  assert.deepEqual(owned, [pack1.tenantId]);
  const hidden = await value(`select count(*) from refund_runtime.cases where tenant_id=${quote(pack2.tenantId)};`, { role: 'authenticated', userId: ids.reviewer1 });
  assert.equal(hidden, 0);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await rejected(`update refund_runtime.cases set revision=revision+1 where tenant_id=${quote(pack1.tenantId)};`, { role, userId: ids.reviewer1 }, /42501/);
    await rejected(`delete from refund_runtime.memberships where tenant_id=${quote(pack1.tenantId)};`, { role, userId: ids.reviewer1 }, /42501/);
    await rejected(`insert into refund_runtime.memberships(tenant_id,user_id,role) values (${quote(pack1.tenantId)},${quote(ids.outsider)},'reviewer');`, { role, userId: ids.reviewer1 }, /42501/);
  }
  await rejected(`update refund_runtime.cases set order_id=${quote(pack2.data.orders[0].id)} where tenant_id=${quote(pack1.tenantId)} and id=${quote(pack1.data.cases[0].id)};`, {}, /23503/);
  return { checkedTableRolePairs: privileges.length, directWrites: 'denied', visibleTenants: owned, foreignTenantRows: hidden, crossTenantForeignKey: 'rejected' };
}
async function runTransitionChecks(ctx) {
  const { sql, value, rejected, check, quote, json, uuid, text, int, rpc, ids, actor,
    pack1, pack2, readWorkspace, readCase, claim, propose, finishSql, finish, enqueue } = ctx;
  const approveSql = (item, { revision = item.revision, fingerprint = item.fingerprint, amount = item.proposedAmountMinor,
    commandId = randomUUID(), note = 'Isolated database test decision; no application case or provider is affected.' } = {}) =>
    rpc('approve_and_reserve', [uuid(pack1.tenantId), text(item.id), int(revision), text(fingerprint), int(amount), text(note), uuid(commandId)]);
  const original = await readCase(pack1, pack1.data.cases[0].id);
  assert.equal(original.outcome, 'awaiting-approval');
  assert.equal(original.proposedAmountMinor, 2000);
  assert.match(original.fingerprint, /^[a-f0-9]{64}$/);

  await check('investigators cannot approve, and stale or altered approval arguments create no reservation', async () => {
    await rejected(approveSql(original), actor(ids.worker1), /42501/);
    await rejected(approveSql(original, { revision: original.revision - 1 }), actor(ids.reviewer1), /40001/);
    await rejected(approveSql(original, { fingerprint: 'f'.repeat(64) }), actor(ids.reviewer1), /40001/);
    await rejected(approveSql(original, { amount: original.proposedAmountMinor + 1 }), actor(ids.reviewer1), /40001|22023/);
    await rejected(approveSql(original, { amount: -1 }), actor(ids.reviewer1), /22023/);
    const overPolicy = await readCase(pack1, pack1.data.cases[3].id);
    assert.equal(overPolicy.outcome, 'held');
    await rejected(approveSql(overPolicy), actor(ids.reviewer1), /55000/);
    const remaining = await readCase(pack1, original.id);
    assert.equal(remaining.revision, original.revision);
    assert.ok(!remaining.approval);
    return { investigatorApproval: 'denied', revision: 'rejected', fingerprint: 'rejected', changedAmount: 'rejected', negativeAmount: 'rejected', overPolicy: 'held', approvalCreated: false };
  });

  await check('concurrent intake retries create one request and changed payload reuse is rejected', async () => {
    const event = 'postgres-harness-intake-replay';
    const responses = await Promise.all([value(enqueue(pack1, event), actor(ids.reviewer1)), value(enqueue(pack1, event), actor(ids.reviewer1))]);
    assert.equal(responses[0].request.id, responses[1].request.id);
    assert.equal(responses[0].case.id, responses[1].case.id);
    assert.deepEqual(responses.map(item => item.replayed).sort(), [false, true]);
    await rejected(rpc('enqueue_intake', [uuid(pack1.tenantId), text(event), text(pack1.data.orders[0].id), text('Changed complaint under the same event identity.')]), actor(ids.reviewer1), /23505/);
    const jobs = await Promise.all([claim(pack1, ids.worker1), claim(pack1, ids.worker1b)]);
    assert.equal(jobs.filter(Boolean).length, 1, 'Only one session may own the sole queued request.');
    const index = jobs.findIndex(Boolean), job = jobs[index], worker = [ids.worker1, ids.worker1b][index];
    await finish(pack1, job, worker);
    return { requestId: responses[0].request.id, caseId: responses[0].case.id, requestsCreated: 1, concurrentClaims: 1, changedReplay: 'rejected' };
  });

  await check('expired leases are reclaimed with a higher fence and stale owners cannot finish', async () => {
    await value(enqueue(pack1, 'postgres-harness-lease'), actor(ids.reviewer1));
    const first = await claim(pack1, ids.worker1);
    assert.ok(first);
    const proposal = await propose(first);
    await rejected(finishSql(pack1, first, proposal), actor(ids.worker1b), /40001/);
    // A controlled admin clock fixture avoids waiting for a production lease.
    // The RPC still compares a real stored timestamp against the database clock.
    await sql(`update refund_runtime.intake_requests set lease_until=clock_timestamp()-interval '1 second' where tenant_id=${uuid(pack1.tenantId)} and id=${text(first.requestId)};`);
    await rejected(finishSql(pack1, first, proposal), actor(ids.worker1), /40001/);
    const second = await claim(pack1, ids.worker1b);
    assert.equal(second.requestId, first.requestId);
    assert.ok(second.fence > first.fence);
    await rejected(finishSql(pack1, first, proposal), actor(ids.worker1), /40001/);
    const completed = await finish(pack1, second, ids.worker1b, proposal);
    const replay = await finish(pack1, second, ids.worker1b, proposal);
    assert.equal(completed.case.revision, replay.case.revision);
    assert.equal(completed.case.fingerprint, replay.case.fingerprint);
    await rejected(finishSql(pack1, second, { ...proposal, reason: proposal.reason + ' changed' }), actor(ids.worker1b), /23505|40001/);
    return { requestId: first.requestId, previousFence: first.fence, reclaimedFence: second.fence, staleOwner: 'rejected', exactFinishReplay: true, changedFinishReplay: 'rejected' };
  });

  await check('a changed case revision cannot finish an investigation and failure rolls back the fixture', async () => {
    await value(enqueue(pack1, 'postgres-harness-stale-investigation'), actor(ids.reviewer1));
    const job = await claim(pack1, ids.worker1);
    const proposal = await propose(job);
    await rejected(`begin; update refund_runtime.cases set revision=revision+1 where tenant_id=${uuid(pack1.tenantId)} and id=${text(job.caseId)};
      set role authenticated; set request.jwt.claim.sub=${quote(ids.worker1)}; ${finishSql(pack1, job, proposal)}`, {}, /40001/);
    const before = await readCase(pack1, job.caseId);
    assert.equal(before.revision, job.case.revision);
    await finish(pack1, job, ids.worker1, proposal);
    return { staleRevision: 'rejected', transaction: 'rolled back', recoveredWithOriginalClaim: true };
  });

  await check('database checks hold proposals with altered arithmetic or missing packing evidence', async () => {
    const results = [];
    for (const kind of ['amount', 'evidence']) {
      await value(enqueue(pack1, 'postgres-harness-invalid-' + kind), actor(ids.reviewer1));
      const job = await claim(pack1, ids.worker1);
      const proposal = await propose(job);
      await rejected(finishSql(pack1, job, { ...proposal, lineId: 'x'.repeat(200) }), actor(ids.worker1), /22023/);
      if (kind === 'amount') proposal.amountMinor += 1;
      else proposal.evidenceIds = [];
      const result = await finish(pack1, job, ids.worker1, proposal);
      assert.equal(result.case.outcome, 'held');
      assert.equal(result.case.checks.find(entry => entry.id === kind)?.pass, false);
      assert.ok(!result.case.approval && !result.case.operationId && !result.case.receipt);
      await rejected(approveSql(result.case), actor(ids.reviewer1), /55000/);
      results.push({ incorrectFact: kind, outcome: result.case.outcome, operationCreated: false });
    }
    return results;
  });

  await check('changed policy invalidates a saved recommendation before approval and creates no operation', async () => {
    const candidate = await readCase(pack1, pack1.data.cases[1].id);
    await rejected(`begin;
      insert into refund_runtime.policies(tenant_id,version,limit_minor) values (${uuid(pack1.tenantId)},2,100);
      update refund_runtime.tenants set current_policy_version=2 where id=${uuid(pack1.tenantId)};
      set role authenticated; set request.jwt.claim.sub=${quote(ids.reviewer1)}; ${approveSql(candidate)}`, {}, /40001|55000/);
    const after = await readCase(pack1, candidate.id);
    assert.equal(after.revision, candidate.revision);
    assert.equal(after.fingerprint, candidate.fingerprint);
    assert.ok(!after.approval);
    return { changedPolicy: 'rejected', originalFactsPreserved: true, approvalCreated: false };
  });

  await check('two identical concurrent human commands create one immutable disabled reservation', async () => {
    const commandId = randomUUID();
    const statement = approveSql(original, { commandId });
    const responses = await Promise.all([value(statement, actor(ids.reviewer1)), value(statement, actor(ids.reviewer1))]);
    assert.equal(responses[0].operation.id, responses[1].operation.id);
    assert.deepEqual(responses.map(item => item.replayed).sort(), [false, true]);
    for (const result of responses) {
      assert.equal(result.case.outcome, 'approved-not-submitted');
      assert.equal(result.case.status, 'paused');
      assert.equal(result.case.stage, 'payments');
      assert.equal(result.operation.status, 'reserved');
      assert.equal(result.operation.submissionEnabled, false);
      assert.equal(result.operation.amountMinor, 2000);
      assert.ok(result.case.approval);
      assert.ok(!result.case.receipt);
    }
    await rejected(approveSql(original, { commandId, amount: 2001 }), actor(ids.reviewer1), /23505/);
    await rejected(statement, actor(ids.worker1), /42501/);
    const pendingSameOrder = (await readWorkspace(pack1, ids.reviewer1)).cases.find(item => item.orderId === original.orderId && item.id !== original.id && item.outcome === 'awaiting-approval');
    assert.ok(pendingSameOrder);
    await rejected(approveSql(pendingSameOrder), actor(ids.reviewer1), /40001/);
    return { operationId: responses[0].operation.id, operationsCreated: 1, amountMinor: 2000, status: 'reserved', submissionEnabled: false, exactCommandReplay: true, changedCommandReplay: 'rejected' };
  });

  await check('concurrent approvals of duplicate claims reserve the shared remedy only once', async () => {
    const a = await readCase(pack1, pack1.data.cases[9].id);
    const b = await readCase(pack1, pack1.data.cases[10].id);
    assert.equal(a.orderId, b.orderId);
    assert.equal(a.outcome, 'awaiting-approval');
    assert.equal(b.outcome, 'awaiting-approval');
    const results = await Promise.allSettled([value(approveSql(a), actor(ids.reviewer1)), value(approveSql(b), actor(ids.reviewer1))]);
    const successes = results.filter(item => item.status === 'fulfilled').map(item => item.value);
    const failures = results.filter(item => item.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.match(failures[0].reason.message, /23505|40001/);
    const rows = await value(`select jsonb_build_object('count',count(*),'amountMinor',coalesce(sum(amount_minor),0),'enabled',coalesce(bool_or(submission_enabled),false)) from refund_runtime.operations where tenant_id=${uuid(pack1.tenantId)} and order_id=${text(a.orderId)} and not seeded;`);
    assert.equal(rows.count, 1);
    assert.equal(rows.amountMinor, 1800);
    assert.equal(rows.enabled, false);
    const loserId = successes[0].case.id === a.id ? b.id : a.id;
    assert.ok(!(await readCase(pack1, loserId)).approval, 'The rejected racing decision must not leave a partial approval.');
    return { orderId: a.orderId, successfulReservations: rows.count, reservedMinor: rows.amountMinor, losingApproval: 'rolled back', submissionEnabled: false };
  });

  await check('the actual asynchronous repository accepts real SQL results through an injected local transport', async () => {
    const tokens = new Map();
    const tokenFor = userId => {
      const token = ['test-only', Buffer.from(JSON.stringify({ role: 'authenticated', sub: userId, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url'), 'not-a-signature'].join('.');
      tokens.set(token, userId); return token;
    };
    const allowed = {
      read_workspace: ['p_tenant_id'], read_case: ['p_tenant_id', 'p_case_id'],
      enqueue_intake: ['p_tenant_id', 'p_event_id', 'p_order_id', 'p_complaint'],
      claim_intake: ['p_tenant_id', 'p_lease_seconds'],
      finish_intake: ['p_tenant_id', 'p_request_id', 'p_fence', 'p_proposal'],
      approve_and_reserve: ['p_tenant_id', 'p_case_id', 'p_expected_revision', 'p_expected_fingerprint', 'p_expected_amount_minor', 'p_note', 'p_command_id'],
    };
    const counts = {};
    const injectedTransport = async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://offline-verification.supabase.co');
      assert.equal(options.method, 'POST');
      const name = target.pathname.replace('/rest/v1/rpc/refund_runtime_', '');
      assert.ok(allowed[name], 'Only the six documented operational RPCs may be translated.');
      const input = JSON.parse(options.body);
      assert.deepEqual(Object.keys(input).sort(), [...allowed[name]].sort());
      assert.equal(input.p_tenant_id, pack1.tenantId);
      const userId = tokens.get(options.headers.Authorization.replace(/^Bearer /, ''));
      assert.ok(userId, 'Only known synthetic transport tokens are accepted.');
      const parameters = allowed[name].map(key => {
        const entry = input[key];
        if (key === 'p_proposal') return `${key}=>${json(entry)}`;
        if (['p_fence', 'p_expected_revision', 'p_expected_amount_minor', 'p_lease_seconds'].includes(key)) {
          assert.ok(Number.isSafeInteger(entry)); return `${key}=>${entry}::${key === 'p_lease_seconds' ? 'integer' : 'bigint'}`;
        }
        assert.equal(typeof entry, 'string');
        return `${key}=>${key === 'p_tenant_id' || key === 'p_command_id' ? uuid(entry) : text(entry)}`;
      });
      counts[name] = (counts[name] || 0) + 1;
      // There is no HTTP request here. PostgreSQL is real; the transport, token
      // decoding and auth.uid identity are intentionally test stand-ins.
      const result = await sql(rpc(name, parameters), { ...actor(userId), allowFailure: true });
      if (result.code !== 0) {
        const code = result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] || 'P0001';
        return Response.json({ code }, { status: code === '42501' ? 403 : 400 });
      }
      return Response.json(JSON.parse(result.stdout.trim().split('\n').at(-1)));
    };
    const repository = userId => createSupabaseRuntimeRepository({
      env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_WORKING_STORE: 'supabase', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase-runtime',
        SUPABASE_URL: 'https://offline-verification.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture_only' },
      tenantId: pack1.tenantId, getAccessToken: () => tokenFor(userId), fetchImpl: injectedTransport,
    });
    const reviewer = repository(ids.reviewer1), worker = repository(ids.worker1);
    assert.equal((await reviewer.readWorkspace()).paymentsEnabled, false);
    assert.equal((await reviewer.readCase(pack1.data.cases[11].id)).outcome, 'awaiting-approval');
    const order = pack1.data.orders.find(entry => entry.id === pack1.data.cases[11].orderId);
    const request = await reviewer.enqueueIntake({ eventId: 'postgres-harness-client-bridge', orderId: order.id, complaint: order.sampleComplaint });
    assert.equal(request.readbackVerified, true);
    await assert.rejects(reviewer.claimIntake(), error => error.code === 'runtime_access_denied' && !error.uncertain);
    const job = await worker.claimIntake();
    assert.equal(job.caseId, request.case.id);
    const result = await worker.finishIntake({ requestId: job.requestId, fence: job.fence, proposal: await propose(job) });
    assert.equal(result.readbackVerified, true);
    assert.equal(result.case.outcome, 'awaiting-approval');
    const approvalInput = { caseId: result.case.id, expectedRevision: result.case.revision, expectedFingerprint: result.case.fingerprint,
      expectedAmountMinor: result.case.proposedAmountMinor, note: 'Explicit synthetic SQL harness decision; payment remains disabled.', commandId: randomUUID() };
    const approved = await reviewer.approveAndReserve(approvalInput);
    assert.equal(approved.readbackVerified, true);
    assert.equal(approved.case.approval.state, 'approved');
    assert.equal(approved.operation.amountMinor, 850);
    assert.equal(approved.operation.submissionEnabled, false);
    const replay = await reviewer.approveAndReserve(approvalInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation.id, approved.operation.id);
    return { transport: 'injected SQL bridge; no HTTP', identity: 'test stub; no JWT verification', rpcCalls: counts,
      independentReadbacks: true, amountMinor: 850, submissionEnabled: false };
  });

  await check('all resulting operations remain seeded history or disabled reservations, with order balances intact', async () => {
    const rows = await value("select coalesce(jsonb_agg(jsonb_build_object('tenantId',tenant_id,'id',id,'orderId',order_id,'amountMinor',amount_minor,'status',status,'seeded',seeded,'submissionEnabled',submission_enabled) order by tenant_id,id),'[]'::jsonb) from refund_runtime.operations;");
    const history = rows.filter(row => row.seeded), newlyReserved = rows.filter(row => !row.seeded);
    assert.equal(history.length, 5);
    assert.equal(newlyReserved.length, 3);
    assert.ok(history.every(row => row.status === 'succeeded' && !row.submissionEnabled));
    assert.ok(newlyReserved.every(row => row.status === 'reserved' && !row.submissionEnabled));
    await rejected(`update refund_runtime.operations set submission_enabled=true where tenant_id=${uuid(pack1.tenantId)} and id=${text(newlyReserved[0].id)};`);
    await rejected(`update refund_runtime.operations set status='succeeded' where tenant_id=${uuid(pack1.tenantId)} and id=${text(newlyReserved[0].id)};`);
    await rejected(`update refund_runtime.operations set payload=payload||'{"amountMinor":1}'::jsonb where tenant_id=${uuid(pack1.tenantId)} and id=${text(newlyReserved[0].id)};`, {}, /55000/);
    await rejected(`update refund_runtime.operations set idempotency_key='changed-retry-identity' where tenant_id=${uuid(pack1.tenantId)} and id=${text(newlyReserved[0].id)};`, {}, /55000/);
    await rejected(`delete from refund_runtime.operations where tenant_id=${uuid(pack1.tenantId)} and id=${text(newlyReserved[0].id)};`, {}, /55000/);
    await rejected(`update refund_runtime.approvals set snapshot='{}'::jsonb where tenant_id=${uuid(pack1.tenantId)};`, {}, /55000/);
    await rejected(`delete from refund_runtime.events where tenant_id=${uuid(pack1.tenantId)};`, {}, /55000/);
    for (const pack of [pack1, pack2]) {
      for (const order of pack.data.orders) {
        const total = rows.filter(row => row.tenantId === pack.tenantId && row.orderId === order.id).reduce((sum, row) => sum + row.amountMinor, 0);
        assert.ok(total <= order.totalMinor, `Remedies exceed the order value: ${order.id}`);
      }
      assert.equal((await readWorkspace(pack, pack === pack1 ? ids.reviewer1 : ids.reviewer2)).paymentsEnabled, false);
    }
    const submissionFunctions = await value("select coalesce(jsonb_agg(p.proname),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','refund_runtime') and p.proname ~ '(submit|settle|execute_payment)';");
    assert.deepEqual(submissionFunctions, []);
    return { historicalFixtures: history.length, newDisabledReservations: newlyReserved.length, reservedMinor: newlyReserved.reduce((sum, row) => sum + row.amountMinor, 0), executablePayments: 0, providerSubmissions: 0, orderBalances: 'within order totals', paymentSubmissionRPCs: [] };
  });
}
