import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createProviders } from '../../server/providers.mjs';
import { createRuntimePaymentExecutor, createRuntimePaymentRepository } from '../../server/runtime-payments.mjs';
import { ENABLED, providerFixture } from './fixtures.mjs';

// Explicit disposable PostgreSQL harness only. Fixtures never reach a provider
// and all SQL runs in the newly owned network=none container, not a preview.
export async function runPaymentChecks({ ROOT, sql, value, rejected, check, quote }) {
  const tenantId = '60000000-0000-4000-8000-000000000012';
  const reviewer = '60000000-0000-4000-8000-000000000001', investigator = '60000000-0000-4000-8000-000000000002', executor1 = '60000000-0000-4000-8000-000000000003', executor2 = '60000000-0000-4000-8000-000000000004';
  const uuid = v => `${quote(v)}::uuid`, text = v => `${quote(v)}::text`, json = v => `${quote(JSON.stringify(v))}::jsonb`, int = v => `${v}::bigint`;
  const actor = userId => ({ role: 'authenticated', userId });
  const rpc = (name, args = []) => `select public.refund_runtime_${name}(${[uuid(tenantId), ...args].join(',')});`;
  const pack = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
  const local = createProviders({ env: {}, fetchImpl() { assert.fail('External provider access'); } });
  const note = 'Synthetic test only: exact mapping, original approval and unchanged evidence checked again.';
  const executions = [], operations = [];
  const authoriseArgs = (item, op, commandId = randomUUID()) => [text(op.id), int(item.revision), uuid(item.approval.id), text(item.approval.fingerprint), int(op.amountMinor), json({ accountId: 'acct_OfflineFixture', paymentIntentId: 'pi_Offline' + item.id.replaceAll('-', ''), orderId: op.orderId, paymentAmountMinor: item.approval.snapshot.order.totalMinor, currency: 'gbp', livemode: false }), text(note), uuid(commandId)];
  function makeRepo(userId) {
    return createRuntimePaymentRepository({ env: ENABLED, tenantId, rpc: async (name, params) => {
      assert.match(name, /^refund_runtime_[a-z_]+$/);
      const uuidKeys = new Set(['p_tenant_id','p_execution_id','p_original_approval_id','p_command_id']);
      const values = Object.entries(params).map(([key, entry]) => `${key} => ${entry === null ? 'NULL' : typeof entry === 'number' ? String(entry) : typeof entry === 'object' ? json(entry) : uuidKeys.has(key) ? uuid(entry) : text(entry)}`);
      const result = await sql(`select public.${name}(${values.join(',')});`, { ...actor(userId), allowFailure: true });
      if (result.code !== 0) throw Object.assign(new Error('The isolated payment RPC rejected the action.'), { sqlState: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] });
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    } });
  }
  const repo = makeRepo(executor1);

  await check('optional execution migration creates a separate dedicated-role boundary without converting reservations', async () => {
    const installed002 = await value("select to_json(to_regprocedure('public.refund_runtime_review_case(uuid,text,bigint,text,text,uuid)') is not null);");
    if (!installed002) await sql(readFileSync(join(ROOT, 'integrations/supabase/runtime/002_office_workflow.sql'), 'utf8'));
    const bytes = readFileSync(join(ROOT, 'integrations/supabase/runtime/004_payment_execution.sql'));
    await sql(bytes.toString('utf8'));
    await sql(`insert into auth.users(id) values ${[reviewer, investigator, executor1, executor2].map(id => `(${uuid(id)})`).join(',')};`);
    await value(rpc('import_dataset', [json(pack.data), text(pack.manifest.digest), json([{ userId: reviewer, role: 'reviewer' }, { userId: investigator, role: 'investigator' }])]));
    await sql(`insert into refund_runtime.memberships(tenant_id,user_id,role) values(${uuid(tenantId)},${uuid(executor1)},'payment-executor'),(${uuid(tenantId)},${uuid(executor2)},'payment-executor');`);
    for (;;) {
      const claim = await value(rpc('claim_intake'), actor(investigator)); if (!claim) break;
      const proposal = await local.proposeCase({ complaint: claim.case.complaint, order: claim.order, evidence: claim.evidence });
      await value(rpc('finish_intake', [text(claim.requestId), int(claim.fence), json(proposal)]), actor(investigator));
    }
    const workspace = await value(rpc('read_workspace'), actor(reviewer)), orders = new Set();
    for (const item of workspace.cases.filter(c => c.outcome === 'awaiting-approval')) {
      if (orders.has(item.orderId)) continue; orders.add(item.orderId);
      const result = await value(rpc('approve_and_reserve', [text(item.id), int(item.revision), text(item.fingerprint), int(item.proposedAmountMinor), text(note), uuid(randomUUID())]), actor(reviewer));
      operations.push(result);
    }
    assert.equal(operations.length, 5);
    assert.equal(await value(`select count(*)::int from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)};`), 0);
    for (const table of ['payment_executions','payment_execution_commands','payment_execution_events']) {
      const grants = await value(`select jsonb_build_object('insert',has_table_privilege('authenticated',${text('refund_runtime.' + table)},'INSERT'),'update',has_table_privilege('authenticated',${text('refund_runtime.' + table)},'UPDATE'),'delete',has_table_privilege('authenticated',${text('refund_runtime.' + table)},'DELETE'));`);
      assert.deepEqual(grants, { insert: false, update: false, delete: false });
    }
    await rejected(rpc('claim_execution', [uuid(randomUUID())]), actor(reviewer), /42501/);
    await rejected(rpc('claim_execution', [uuid(randomUUID())]), actor(investigator), /42501/);
    return { migrationSha256: createHash('sha256').update(bytes).digest('hex'), untouchedDisabledReservations: operations.length, newExecutionAuthorisations: 0, executorRoleSeparate: true };
  });

  await check('a new exact reviewer authorisation is idempotent and old decisions or altered mappings cannot execute', async () => {
    for (const row of operations) {
      const args = authoriseArgs(row.case, row.operation);
      await rejected(rpc('authorise_execution', args), actor(investigator), /42501/);
      await rejected(rpc('authorise_execution', args), actor(executor1), /42501/);
      const first = await value(rpc('authorise_execution', args), actor(reviewer));
      assert.equal(first.status, 'authorised'); assert.equal(first.submittedAt, null); assert.equal(first.originalOperation.submissionEnabled, false);
      assert.equal((await value(rpc('authorise_execution', args), actor(reviewer))).id, first.id);
      const changed = [...args]; changed[6] = text(note + ' Changed.');
      await rejected(rpc('authorise_execution', changed), actor(reviewer), /23505/);
      const newCommand = [...args]; newCommand[7] = uuid(randomUUID());
      await rejected(rpc('authorise_execution', newCommand), actor(reviewer), /23505/);
      const liveMapping = [...args]; liveMapping[7] = uuid(randomUUID()); liveMapping[5] = json({ ...first.mapping, livemode: true });
      await rejected(rpc('authorise_execution', liveMapping), actor(reviewer), /22023/);
      const wrongAmount = [...args]; wrongAmount[7] = uuid(randomUUID()); wrongAmount[5] = json({ ...first.mapping, paymentAmountMinor: first.mapping.paymentAmountMinor + 1 });
      await rejected(rpc('authorise_execution', wrongAmount), actor(reviewer), /40001/);
      executions.push(first);
    }
    assert.equal(await value(`select count(*)::int from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)};`, actor(investigator)), 0);
    await rejected(rpc('read_execution', [uuid(executions[0].id)]), { role: 'anon' }, /42501/);
    await rejected(rpc('read_execution', [uuid(executions[0].id)]), actor(investigator), /42501/);
    return { separateAuthorisations: executions.length, repeatedDecisionsDeduplicated: true, investigatorsCannotReadOrSubmitExecution: true };
  });

  await check('changed original evidence or policy blocks execution and authorisation payloads are immutable', async () => {
    const e = executions[3];
    const result = await sql(`begin; update refund_runtime.policies set limit_minor=limit_minor+1 where tenant_id=${uuid(tenantId)}; set local role authenticated; set local request.jwt.claim.sub=${quote(executor1)}; set local request.jwt.claims=${quote(JSON.stringify({ sub: executor1, role: 'authenticated', is_anonymous: false }))}; ${rpc('claim_execution', [uuid(e.id)])} rollback;`, { allowFailure: true });
    assert.notEqual(result.code, 0); assert.match(result.stderr, /40001/);
    const evidenceChanged = await sql(`begin; update refund_runtime.evidence set data=jsonb_set(data,'{body}',to_jsonb('Synthetic changed evidence'::text)) where tenant_id=${uuid(tenantId)} and case_id=${text(e.caseId)}; set local role authenticated; set local request.jwt.claim.sub=${quote(executor1)}; set local request.jwt.claims=${quote(JSON.stringify({ sub: executor1, role: 'authenticated', is_anonymous: false }))}; ${rpc('claim_execution', [uuid(e.id)])} rollback;`, { allowFailure: true });
    assert.notEqual(evidenceChanged.code, 0); assert.match(evidenceChanged.stderr, /40001/);
    await rejected(`update refund_runtime.payment_executions set payload=jsonb_set(payload,'{amountMinor}','1') where tenant_id=${uuid(tenantId)} and id=${uuid(e.id)};`, {}, /55000/);
    await rejected(`update refund_runtime.payment_executions set original_fingerprint='changed' where tenant_id=${uuid(tenantId)} and id=${uuid(e.id)};`, {}, /55000/);
    assert.equal((await repo.readExecution(e.id)).status, 'authorised');
    return { changedFactsCannotClaim: true, mappingAndPayloadImmutable: true };
  });

  await check('concurrent dedicated executors get one claim and expired leases fence out prior actors', async () => {
    const e = executions[2], statement = rpc('claim_execution', [uuid(e.id)]);
    const results = await Promise.all([executor1,executor2].map(userId => sql(statement, { ...actor(userId), allowFailure: true })));
    assert.equal(results.filter(r => r.code === 0).length, 1);
    const claimed = JSON.parse(results.find(r => r.code === 0).stdout.trim().split('\n').at(-1));
    await sql(`update refund_runtime.payment_executions set lease_until=clock_timestamp()-interval '1 second' where tenant_id=${uuid(tenantId)} and id=${uuid(e.id)};`);
    const next = await repo.claimExecution({ executionId: e.id }); assert.equal(next.fence, claimed.fence + 1);
    await rejected(rpc('begin_submission', [uuid(e.id), int(claimed.fence), text(e.payloadDigest)]), actor(claimed.leaseActor), /40001/);
    const begun = await repo.beginSubmission({ executionId: e.id, fence: next.fence, payloadDigest: e.payloadDigest }); assert.equal(begun.status, 'submitting');
    await rejected(rpc('begin_submission', [uuid(e.id), int(next.fence), text(e.payloadDigest)]), actor(executor1), /55000/);
    for (const userId of [reviewer,investigator]) for (const [name,args] of [
      ['begin_submission',[uuid(e.id),int(next.fence),text(e.payloadDigest)]],
      ['save_refund_reference',[uuid(e.id),int(next.fence),json({})]],
      ['note_execution_unknown',[uuid(e.id),int(next.fence),text('test_error')]],
      ['claim_reconciliation',[uuid(e.id)]],
      ['record_refund_readback',[uuid(e.id),int(next.fence),json({})]],
    ]) await rejected(rpc(name,args), actor(userId), /42501/);
    const p = providerFixture(e, [], { status: 'pending' });
    const refund = await p.readRefund('re_OfflinePending');
    await repo.saveRefundReference({ executionId: e.id, fence: next.fence, refund });
    await repo.recordRefundReadback({ executionId: e.id, fence: next.fence, refund });
    const reconciliationLog = [], provider = providerFixture(e, reconciliationLog);
    const result = await createRuntimePaymentExecutor({ env: ENABLED, repository: repo, provider }).reconcile(e.id);
    assert.equal(result.execution.status, 'succeeded'); assert.equal(reconciliationLog.includes('refund:post'), false);
    return { exclusiveClaim: true, staleFenceRejected: true, reviewerAndInvestigatorCannotExecute: true, reconciliationPosted: false };
  });

  await check('the actual prepared executor saves intent before one injected POST and independently records matching readback', async () => {
    const e = executions[0], log = [], fixture = providerFixture(e, log);
    const provider = { ...fixture, createRefund: async payload => {
      const saved = await repo.readExecution(e.id); assert.equal(saved.status, 'submitting'); assert.ok(saved.submittedAt); assert.deepEqual(saved.payload, payload);
      return fixture.createRefund(payload);
    } };
    const result = await createRuntimePaymentExecutor({ env: ENABLED, repository: repo, provider }).execute(e.id);
    assert.equal(result.execution.status, 'succeeded'); assert.equal(result.readbackVerified, true); assert.equal(result.liveVerified, false);
    assert.equal(log.filter(v => v === 'refund:post').length, 1); assert.ok(log.indexOf('refund:get') > log.indexOf('refund:post'));
    const original = await value(`select refund_runtime.operation_json(${uuid(tenantId)},${text(e.operationId)});`);
    assert.deepEqual(original, e.originalOperation);
    await assert.rejects(createRuntimePaymentExecutor({ env: ENABLED, repository: repo, provider }).execute(e.id));
    assert.equal(log.filter(v => v === 'refund:post').length, 1);
    return { injectedProviderOnly: true, durableIntentBeforePost: true, providerPosts: 1, independentRefundReadback: true, originalReservationUnchanged: true, liveStripeVerified: false };
  });

  await check('a lost provider response preserves its original key and blocks receiptless retry, reconciliation and second authorisation', async () => {
    const e = executions[1], log = [], fixture = providerFixture(e, log);
    fixture.createRefund = async () => { log.push('refund:post'); throw new Error('Injected lost response'); };
    const executor = createRuntimePaymentExecutor({ env: ENABLED, repository: repo, provider: fixture });
    await assert.rejects(executor.execute(e.id), error => error.code === 'payment_execution_uncertain' && error.uncertain);
    const saved = await repo.readExecution(e.id); assert.equal(saved.status, 'uncertain'); assert.ok(saved.submittedAt); assert.equal(saved.refundId, null); assert.equal(saved.idempotencyKey, e.idempotencyKey);
    await assert.rejects(executor.execute(e.id)); await assert.rejects(executor.reconcile(e.id));
    assert.equal(log.filter(v => v === 'refund:post').length, 1);
    const row = operations[1]; await rejected(rpc('authorise_execution', authoriseArgs(row.case, row.operation)), actor(reviewer), /23505/);
    await rejected(`update refund_runtime.payment_executions set submitted_at=null,status='authorised' where tenant_id=${uuid(tenantId)} and id=${uuid(e.id)};`, {}, /55000/);
    return { uncertainOutcomeDurable: true, sameKeyPreserved: true, receiptlessResubmissionBlocked: true, guessedRefundReconciliationBlocked: true };
  });

  await check('all original cases and disabled reservation rows remain unchanged after optional execution checks', async () => {
    for (const row of operations) {
      const saved = await value(rpc('read_case', [text(row.case.id)]), actor(reviewer));
      assert.equal(saved.revision, row.case.revision); assert.equal(saved.outcome, 'approved-not-submitted'); assert.equal(saved.receipt, null);
      assert.deepEqual(await value(`select refund_runtime.operation_json(${uuid(tenantId)},${text(row.operation.id)});`), row.operation);
    }
    return { originalCasesUnchanged: operations.length, originalReservationRowsUnchanged: operations.length, realNetworkRequests: 0, previewDatabasesAccessed: 0 };
  });

  await check('three expired pre-submission claims exhaust automatic retry without changing the authorisation or retry key', async () => {
    const e = executions[4]; let last;
    for (let i = 0; i < 3; i++) {
      last = await repo.claimExecution({ executionId: e.id }); assert.equal(last.fence, i + 1);
      await sql(`update refund_runtime.payment_executions set lease_until=clock_timestamp()-interval '1 second' where tenant_id=${uuid(tenantId)} and id=${uuid(e.id)};`);
    }
    await assert.rejects(repo.claimExecution({ executionId: e.id }));
    await assert.rejects(repo.beginSubmission({ executionId: e.id, fence: last.fence, payloadDigest: e.payloadDigest }));
    const saved = await repo.readExecution(e.id); assert.equal(saved.submittedAt, null); assert.equal(saved.idempotencyKey, e.idempotencyKey); assert.equal(saved.fence, 3);
    return { maximumPreSubmissionClaims: 3, exhaustedAutomaticallyStopped: true, submissionIntents: 0, immutableAuthorisation: true };
  });
}
