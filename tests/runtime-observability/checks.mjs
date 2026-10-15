import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createLocalPostgresRuntime } from '../../server/local-postgres-runtime.mjs';
import { createRuntimeService } from '../../server/runtime-service.mjs';
import { createLocalObserver } from '../../server/observability.mjs';

export async function runRuntimeObservabilityChecks({ ROOT, sql, value, check, quote, outputDir }) {
  const tenantId = randomUUID(), reviewerId = randomUUID(), investigatorId = randomUUID();
  const uuid = v => `${quote(v)}::uuid`, text = v => `${quote(v)}::text`, json = v => `${quote(JSON.stringify(v))}::jsonb`;
  const reviewer = { tenantId, userId: reviewerId, role: 'reviewer' }, investigator = { tenantId, userId: investigatorId, role: 'investigator' };
  const pack = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
  const executeSql = async ({ statement, userId, role }) => {
    const result = await sql(statement, { userId, role, allowFailure: true });
    if (result.code !== 0) throw Object.assign(new Error('Isolated trace test SQL rejected'), { sqlState: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] });
    const body = result.stdout.trim(); return body ? JSON.parse(body) : null;
  };
  const repositoryForSession = profile => createLocalPostgresRuntime({ executeSql, tenantId, profile });
  const observer = createLocalObserver({ filePath: join(outputDir, 'runtime-traces.jsonl'), runId: randomUUID(), projectName: 'refund-office-postgres-check' });
  const service = createRuntimeService({ repositoryForSession, workerRepository: repositoryForSession(investigator), automaticWorker: false, evidenceClarification: true, observer, packId: 'focused-12' });
  const noPayments = () => value(`select jsonb_build_object('approvals',(select count(*) from refund_runtime.approvals where tenant_id=${uuid(tenantId)}),'newOperations',(select count(*) from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded));`);
  let workspace;
  try {
    await check('all seven migrations support a fresh traced synthetic tenant without existing preview mounts', async () => {
      for (const name of ['002_office_workflow.sql', '003_hosted_access.sql', '004_payment_execution.sql', '005_sponsor_actions.sql', '006_payment_review.sql', '007_evidence_clarification.sql']) await sql(readFileSync(join(ROOT, 'integrations/supabase/runtime', name), 'utf8'));
      await sql(`insert into auth.users(id) values(${uuid(reviewerId)}),(${uuid(investigatorId)});`);
      await value(`select public.refund_runtime_import_dataset(${uuid(tenantId)},${json(pack.data)},${text(pack.manifest.digest)},${json([{ userId: reviewerId, role: 'reviewer' }, { userId: investigatorId, role: 'investigator' }])});`);
      workspace = await repositoryForSession(reviewer).readWorkspace();
      assert.equal(workspace.cases.length, 12); assert.equal(observer.snapshot().spans.length, 0);
      return { syntheticCases: 12, retrospectiveSpans: 0, liveProviders: 0 };
    });
    await check('actual PostgreSQL investigation spans bind each saved outcome, revision and policy result', async () => {
      for (let index = 0; index < 12; index++) {
        const before = observer.snapshot().spans.length;
        const result = await service.runNext(investigator);
        const saved = await repositoryForSession(reviewer).readCase(result.case.id);
        const spans = observer.snapshot().spans.slice(before), root = spans.find(span => span.name === 'refund.investigation');
        assert.equal(spans.length, 4); assert.ok(root);
        assert.equal(root.attributes.caseId, saved.caseId); assert.equal(root.attributes['case.revision'], saved.revision);
        assert.equal(root.attributes['decision.state'], saved.outcome); assert.equal(root.attributes.outcome, saved.outcome);
        assert.equal(root.attributes.amountMinor, saved.proposedAmountMinor);
        assert.equal(root.attributes['checks.count'], saved.checks.length); assert.equal(root.attributes['checks.passed'], saved.checks.filter(c => c.pass).length);
        assert.ok(spans.every(span => span.attributes.synthetic === true && span.attributes.analyser === 'local-rules' && span.attributes.provider === 'local' && span.attributes.caseId === saved.caseId));
        assert.deepEqual(spans.filter(span => span.parentSpanId === root.spanId).map(span => span.name).sort(), ['refund.investigation.claim', 'refund.investigation.finish', 'refund.investigation.propose']);
        assert.ok(spans.every(span => span.traceId === root.traceId));
        assert.equal(saved.approval, null);
      }
      workspace = await repositoryForSession(reviewer).readWorkspace();
      assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0 });
      await observer.flush(); assert.equal(observer.status().writeState, 'saved');
      assert.equal(readFileSync(join(outputDir, 'runtime-traces.jsonl'), 'utf8').trim().split('\n').length, 48);
      return { investigatedCases: 12, actualNestedSpans: 48, approvals: 0, newOperations: 0 };
    });
    await check('idle polling and existing report reads leave the actual trace unchanged', async () => {
      const before = observer.snapshot();
      for (let index = 0; index < 3; index++) assert.deepEqual(await service.runNext(investigator), { empty: true });
      const bootstrap = await service.bootstrap(reviewer);
      await service.report(reviewer, workspace.cases[0].id);
      assert.deepEqual(observer.snapshot(), before); assert.equal(bootstrap.runtime.observability.retainedSpans, 48);
      assert.equal(bootstrap.runtime.observability.networkEnabled, false);
      return { emptyPolls: 3, additionalSpans: 0, retrospectiveSpans: 0 };
    });
    await check('recorded clarification and its real reinvestigation produce new linked local spans without approval', async () => {
      const target = workspace.cases.find(item => item.caseId === 'RF-2008');
      const held = await service.review(reviewer, target.id, { action: 'request-evidence', expectedRevision: target.revision, commandId: randomUUID(), note: 'Synthetic trace test requests the missing item identity.' });
      const clarified = await service.submitClarification(reviewer, target.id, { expectedRevision: held.revision, lineId: 'SYN-F12-O008-L1', customerStatement: 'The Sketchbook is missing from my order.', sourceReference: 'Synthetic trace test customer reply', note: 'Record the fictional customer reply for investigation, not approval.', commandId: randomUUID() });
      assert.equal(clarified.readbackVerified, true);
      const result = await service.runNext(investigator);
      assert.equal(result.case.id, target.id); assert.equal(result.case.outcome, 'awaiting-approval'); assert.equal(result.case.proposedAmountMinor, 1000);
      const newSpans = observer.snapshot().spans.slice(48);
      assert.equal(newSpans.length, 6);
      assert.equal(newSpans[0].name, 'refund.review.decide'); assert.equal(newSpans[1].name, 'refund.evidence.clarify');
      const last = newSpans.find(span => span.name === 'refund.investigation');
      assert.equal(last.attributes['case.revision'], result.case.revision); assert.equal(last.attributes.caseId, 'RF-2008'); assert.equal(last.attributes.amountMinor, 1000);
      assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0 });
      const serialised = JSON.stringify(observer.snapshot());
      for (const privateValue of [tenantId, reviewerId, investigatorId, target.id, target.complaint, 'The Sketchbook is missing from my order.', 'Synthetic trace test customer reply']) assert.ok(!serialised.includes(privateValue));
      return { clarificationReadback: true, additionalActualSpans: 6, finalAmountMinor: 1000, approvalRequired: true, newOperations: 0 };
    });
    await check('a broken recorder cannot repeat or fail a real PostgreSQL intake command', async () => {
      let calls = 0;
      const raw = repositoryForSession(investigator), repo = { ...raw, async enqueueIntake(input) { calls++; return raw.enqueueIntake(input); } };
      const broken = { async span(_name, _attrs, callback) { const result = await callback(); await callback(); throw new Error('Do not expose recorder diagnostics'); }, status() { throw new Error('Do not expose recorder diagnostics'); }, async flush() { throw new Error('Do not expose recorder diagnostics'); } };
      const guarded = createRuntimeService({ repositoryForSession: () => repo, workerRepository: repo, automaticWorker: false, observer: broken });
      try {
        const eventId = 'trace-guard-' + randomUUID();
        const result = await guarded.intake(investigator, { eventId, orderId: workspace.orders[0].id, complaint: 'Synthetic trace fault test request; do not approve.' });
        const independentlySaved = await raw.readCase(result.case.id);
        assert.equal(calls, 1); assert.equal(independentlySaved.id, result.case.id); assert.equal(independentlySaved.revision, result.case.revision);
        assert.equal(independentlySaved.approval, null);
        const requests = (await raw.readWorkspace()).intakeRequests.filter(request => request.eventId === eventId); assert.equal(requests.length, 1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(guarded.observabilityStatus().degraded, true);
        assert.doesNotMatch(JSON.stringify(guarded.observabilityStatus()), /diagnostics/);
        assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0 });
        return { actualIntakeCalls: 1, savedRequests: 1, originalResultPreserved: true, traceFailureVisible: true, approvals: 0 };
      } finally { await guarded.close(); }
    });
  } finally {
    await service.close();
    writeFileSync(join(outputDir, 'runtime-traces.json'), JSON.stringify(observer.snapshot(), null, 2) + '\n', { mode: 0o600 });
  }
}
