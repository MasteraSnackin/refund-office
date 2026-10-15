import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';
import { createLocalPostgresRuntime } from '../../server/local-postgres-runtime.mjs';
import { createRuntimeService } from '../../server/runtime-service.mjs';
import { createInvestigationProviders } from '../../server/investigation-proposal.mjs';
import { LANGUAGE_CASES } from '../fixtures/claim-language.mjs';
export async function runModelInvestigationChecks({ ROOT, sql, value, rejected, check, quote }) {
  const tenantId = randomUUID(), reviewerId = randomUUID(), investigatorId = randomUUID();
  const u = x => `${quote(x)}::uuid`, j = x => `${quote(JSON.stringify(x))}::jsonb`, tx = x => `${quote(x)}::text`;
  const reviewer = { tenantId, userId: reviewerId, role: 'reviewer' }, investigator = { tenantId, userId: investigatorId, role: 'investigator' };
  const executeSql = async ({ statement, userId, role }) => {
    const r = await sql(statement, { userId, role, allowFailure: true });
    if (r.code !== 0) throw Object.assign(new Error('Isolated model test SQL rejected'), { sqlState: r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] });
    return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null;
  };
  const repo = createLocalPostgresRuntime({ executeSql, tenantId, profile: investigator }), read = createLocalPostgresRuntime({ executeSql, tenantId, profile: reviewer });
  const makeService = investigationProviders => createRuntimeService({ repositoryForSession: s => s.role === 'reviewer' ? read : repo, workerRepository: repo, automaticWorker: false, investigationProviders });
  const local = makeService();
  const noPayments = () => value(`select jsonb_build_object('approvals',(select count(*) from refund_runtime.approvals where tenant_id=${u(tenantId)}),'newOperations',(select count(*) from refund_runtime.operations where tenant_id=${u(tenantId)} and not seeded),'executions',(select count(*) from refund_runtime.payment_executions where tenant_id=${u(tenantId)}));`);
  const good = { amountMinor: 2000, lineId: 'SYN-F12-O001-L1', issue: 'item_missing', reason: 'Synthetic controlled response: saved packing omits one travel mug.', evidenceIds: ['order:SYN-F12-O001', 'packing:SYN-F12-O001'] };
  const providers = (source, result, fail = false) => createInvestigationProviders({ env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: source, REFUND_OFFICE_ENABLED_INTEGRATIONS: source, OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'gpt-test-fixture', ANTHROPIC_API_KEY: 'test-only', ANTHROPIC_MODEL: 'claude-test-fixture' }, responseMode: 'controlled-test', fetchImpl: async () => {
    if (fail) throw new Error('Synthetic provider unavailable');
    return Response.json(source === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] });
  } });
  const enqueue = (complaint = 'The travel mug is missing.', orderId = 'SYN-F12-O001') => repo.enqueueIntake({ eventId: 'model-test:' + randomUUID(), orderId, complaint });
  try {
    await check('eight migrations initialise a fresh model rehearsal without changing existing local proposal formats', async () => {
      for (const name of ['002_office_workflow.sql','003_hosted_access.sql','004_payment_execution.sql','005_sponsor_actions.sql','006_payment_review.sql','007_evidence_clarification.sql','008_model_investigation.sql']) await sql(readFileSync(join(ROOT, 'integrations/supabase/runtime', name), 'utf8'));
      const pack = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT,'demo-data/focused-12.json'),'utf8')));
      await sql(`insert into auth.users(id) values(${u(reviewerId)}),(${u(investigatorId)});`);
      await value(`select public.refund_runtime_import_dataset(${u(tenantId)},${j(pack.data)},${tx(pack.manifest.digest)},${j([{userId:reviewerId,role:'reviewer'},{userId:investigatorId,role:'investigator'}])});`);
      for (let i = 0; i < 12; i++) await local.runNext(investigator);
      assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0, executions: 0 });
      assert.ok((await read.readWorkspace()).cases.every(c => !c.proposal?.provenance));
      return { baseCases: 12, providersContacted: 0 };
    });
    await check('OpenAI and Anthropic controlled responses run through the actual service and database and remain unapproved', async () => {
      for (const source of ['openai','anthropic']) {
        await enqueue(); const service = makeService(providers(source, good));
        try {
          const result = await service.runNext(investigator), saved = await read.readCase(result.case.id);
          assert.equal(saved.outcome,'awaiting-approval'); assert.equal(saved.proposedAmountMinor,2000); assert.equal(saved.proposal.source,source); assert.equal(saved.proposal.provenance.mode,'controlled-test');
          assert.equal(saved.approval,null); assert.equal(saved.operationId,null); assert.equal(saved.receipt,null);
          const event = saved.events.find(e => e.type === 'investigation.finished'); assert.equal(event.payload.provenance.provider, source); assert.match(event.label,/Controlled model test/);
        } finally { await service.close(); }
      }
      return { modelControlledCases: 2, approvals: 0, liveModelCalls: 0 };
    });
    await check('database rejects malformed or unsupported model results even when application validation is bypassed', async () => {
      await enqueue(); const claim = await repo.claimIntake({ leaseSeconds: 120 });
      const base = { ...good, source:'openai', provenance:{provider:'openai',model:'gpt-test-fixture',mode:'controlled-test'} };
      const invalid = [
        {...base,amountMinor:1999}, {...base,lineId:'SYN-F12-O001-L2'}, {...base,lineId:'SYN-F12-O002-L1'}, {...base,evidenceIds:[...good.evidenceIds,'invented:evidence']},
        {...base,evidenceIds:['packing:SYN-F12-O001']}, {...base,evidenceIds:[...good.evidenceIds,good.evidenceIds[0]]}, {...base,approved:true}, {...base,issue:'unknown'},
        {...base,provenance:null}, {...base,provenance:{...base.provenance,provider:'anthropic'}}, {...base,provenance:{...base.provenance,mode:'local-rules'}}, {...base,provenance:{...base.provenance,model:'secret with spaces'}},
      ];
      const before = await read.readCase(claim.caseId);
      for (const proposal of invalid) await rejected(`select public.refund_runtime_finish_intake(${u(tenantId)},${tx(claim.requestId)},${claim.fence},${j(proposal)});`, { role:'authenticated',userId:investigatorId }, /22023/);
      assert.deepEqual(await read.readCase(claim.caseId),before);
      const result = await repo.finishIntake({requestId:claim.requestId,fence:claim.fence,proposal:base});
      assert.equal(result.case.outcome,'awaiting-approval');
      await rejected(`select public.refund_runtime_finish_intake(${u(tenantId)},${tx(claim.requestId)},${claim.fence},${j({...base,reason:'Changed result'})});`,{role:'authenticated',userId:investigatorId},/23505/);
      await rejected(`select public.refund_runtime_finish_intake(${u(tenantId)},${tx(claim.requestId)},${claim.fence},${j(base)});`,{role:'authenticated',userId:reviewerId},/42501/);
      return { rejectedResults: invalid.length, alteredRetryRejected:true, reviewerCannotInvestigate:true };
    });
    await check('database holds generic multi-omission claims while a named unfamiliar paraphrase can use the model', async () => {
      const sketch = { amountMinor:1000,lineId:'SYN-F12-O008-L1',issue:'item_missing',reason:'Controlled model proposes the named sketchbook.',evidenceIds:['order:SYN-F12-O008','packing:SYN-F12-O008'],source:'openai',provenance:{provider:'openai',model:'gpt-test-fixture',mode:'controlled-test'} };
      for (const complaint of ['Some items are missing from my order. Please check the packing record.', 'My order has a sketchbook and a marker set. Some items are missing.']) {
        await enqueue(complaint,'SYN-F12-O008'); const claim = await repo.claimIntake({leaseSeconds:120}), before = await read.readCase(claim.caseId);
        await rejected(`select public.refund_runtime_finish_intake(${u(tenantId)},${tx(claim.requestId)},${claim.fence},${j(sketch)});`,{role:'authenticated',userId:investigatorId},/22023/);
        assert.deepEqual(await read.readCase(claim.caseId),before);
        await repo.failIntake({requestId:claim.requestId,fence:claim.fence,errorCode:'ambiguous_claim'});
      }
      await enqueue('The only claim I am making concerns the sketchbook; that product was left behind at fulfilment.','SYN-F12-O008');
      const {source,provenance,...response} = sketch, service = makeService(providers('openai',response));
      try {
        const result = await service.runNext(investigator), saved = await read.readCase(result.case.id);
        assert.equal(saved.outcome,'awaiting-approval'); assert.equal(saved.proposedAmountMinor,1000); assert.equal(saved.proposal.provenance.mode,'controlled-test'); assert.equal(saved.approval,null);
      } finally { await service.close(); }
      return { genericOrMultiNameRejected:2, explicitParaphraseAccepted:1, approvals:0 };
    });
    await check('model outage and invalid recommendation record recoverable holds without silently using local rules', async () => {
      for (const [source, result, fail] of [['openai',{...good,amountMinor:1},false],['anthropic',good,true]]) {
        const queued = await enqueue(), service = makeService(providers(source,result,fail));
        try { await assert.rejects(service.runNext(investigator)); } finally { await service.close(); }
        const saved = await read.readCase(queued.case.id); assert.equal(saved.outcome,'held'); assert.equal(saved.proposal,null); assert.equal(saved.approval,null);
        const request = (await read.readWorkspace()).intakeRequests.find(r=>r.caseId===saved.id); assert.equal(request.status,'error');
      }
      return { failedInvestigations:2, silentFallbacks:0 };
    });
    await check('all committed customer-language scenarios run against the current PostgreSQL workflow', async () => {
      for (const example of LANGUAGE_CASES) {
        const queued = await enqueue(example.complaint,'SYN-F12-O008'), result = await local.runNext(investigator);
        assert.equal(result.case.id,queued.case.id);
        const saved = await read.readCase(result.case.id); assert.equal(saved.proposal.issue,example.issue,example.id); assert.equal(saved.proposedAmountMinor,example.amountMinor,example.id);
        assert.equal(saved.outcome, example.issue==='item_missing'?'awaiting-approval':'held',example.id); assert.equal(saved.approval,null); assert.equal(saved.operationId,null);
      }
      assert.deepEqual(await noPayments(), { approvals:0,newOperations:0,executions:0 });
      return { languageCases:LANGUAGE_CASES.length, approvals:0,newOperations:0,paymentExecutions:0 };
    });
  } finally { await local.close(); }
}
