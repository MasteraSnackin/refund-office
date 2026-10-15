import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { prepareSyntheticImport } from '../server/supabase-import.mjs';
import { createLocalPostgresRuntime } from '../server/local-postgres-runtime.mjs';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createLocalObserver } from '../server/observability.mjs';
import { buildRuntimeScorecard, prepareRuntimeEvaluationRows } from '../server/runtime-evaluation-scorecard.mjs';
import { renderScorecards } from './evaluate-arize.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKS = ['focused-12', 'busy-50'];
const MIGRATIONS = ['002_office_workflow.sql','003_hosted_access.sql','004_payment_execution.sql','005_sponsor_actions.sql','006_payment_review.sql','007_evidence_clarification.sql','008_model_investigation.sql'];
const hash = x => createHash('sha256').update(x).digest('hex');
function sourceSnapshot() {
  const files = new Map();
  function visit(path) {
    const absolute = resolve(ROOT,path); if (!absolute.startsWith(ROOT)) throw new Error('Source outside project.');
    path = relative(ROOT,absolute); if(files.has(path)) return;
    const data = readFileSync(absolute); files.set(path,{path,sha256:hash(data),bytes:data.length});
    if(/\.[cm]?js$/.test(path)) for(const match of data.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(relative(ROOT,resolve(dirname(absolute),match[1])));
  }
  for(const path of ['scripts/evaluate-runtime.mjs','tests/supabase-runtime/bootstrap.sql','integrations/supabase/runtime/001_runtime.sql',...MIGRATIONS.map(x=>'integrations/supabase/runtime/'+x),...PACKS.map(x=>`demo-data/${x}.json`)])visit(path);
  const rows=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)); return {digest:hash(JSON.stringify(rows)),files:rows};
}
const escape = value => String(value).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
export function renderRuntimeScorecards(scorecards, spans = []) {
  const traceSections = scorecards.flatMap(pack => pack.cases.map(item => {
    const actual = spans.filter(span => span.traceId === item.traceId).sort((a,b) => a.startTimeUnixNano.localeCompare(b.startTimeUnixNano));
    const entries = actual.map(span => `<li><strong>${escape(span.name)}</strong> — ${escape(span.status)}<br><code>${escape(span.spanId)}</code><br>${escape(JSON.stringify(span.attributes))}</li>`).join('');
    return `<details class="panel" id="span-${escape(item.spanId)}"><summary>${escape(item.caseLabel)} · ${escape(pack.dataset.id)} · actual recorded investigation</summary><p>Saved revision ${escape(item.revision)} · ${escape(item.observedOutcome)} · ${escape(item.observedAmountMinor)} pence</p><p>Saved citations: ${item.evidenceRefs.map(escape).join(', ') || 'None'}</p><ul>${entries || '<li>No retained trace was supplied.</li>'}</ul><a href="traces.json">Original local trace JSON</a></details>`;
  })).join('');
  return renderScorecards(scorecards)
    .replace('no approval or payment requested by the runner', 'no approval or payment requested for the evaluated cases')
    .replace('Refund Office — local evaluation','Refund Office — current PostgreSQL evaluation')
    .replace('<h1>Refund Office evaluation</h1>','<h1>Current workflow evaluation</h1>')
    .replace('The runner uses the original application engine in a fresh in-memory store. It does not change your demonstration cases or connect to Arize.','The runner calls the current application service against a fresh local PostgreSQL database. Every outcome is independently read back and linked to its actual investigation span. Existing demonstrations are unchanged; no Arize connection was made.')
    .replace(/Investigation span: <code>([a-f0-9]{16})<\/code>/g, 'Investigation span: <a href="#span-$1"><code>$1</code></a>')
    .replace('</main>', `<h2>Recorded investigations</h2>${traceSections}</main>`)
    .replace('<h2>What this establishes</h2>','<p><a href="observed-cases.json">Observed cases, amounts and evidence references</a> · <a href="verification.json">Disposable database verification</a></p><h2>What this establishes</h2>');
}
export async function runRuntimeEvaluations({ outputBase = join(ROOT,'work/runtime-evaluations') } = {}) {
  const base=resolve(outputBase); if(!base.startsWith(join(ROOT,'work')+'/'))throw new Error('Use a fresh project work directory.');
  mkdirSync(base,{recursive:true});const outputDir=mkdtempSync(join(base,'run-'));
  const save=(name,value)=>writeFileSync(join(outputDir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const before=sourceSnapshot();save('sources-before.json',before);
  let externalRequests=0;const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>{externalRequests++;throw new Error('External requests are disabled by the current-runtime evaluator.');};
  const results=[];let verification,failure;
  try {
    verification=await runSupabaseRuntimeChecks({outputDir,additionalChecks:async({sql,value,check,quote})=>{
      for(const migration of MIGRATIONS)await sql(readFileSync(join(ROOT,'integrations/supabase/runtime',migration),'utf8'));
      for(const packId of PACKS) {
        await check(`current runtime evaluates every ${packId} case and links its independently saved result to actual trace metadata`,async()=>{
          const prepared=prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT,'demo-data',packId+'.json'),'utf8'))),dataset=prepared.data;
          const tenantId=randomUUID(),userId=randomUUID(),reviewerId=randomUUID();
          const uuid=x=>`${quote(x)}::uuid`,json=x=>`${quote(JSON.stringify(x))}::jsonb`;
          await sql(`insert into auth.users(id) values(${uuid(userId)}),(${uuid(reviewerId)});`);
          await value(`select public.refund_runtime_import_dataset(${uuid(tenantId)},${json(dataset)},${quote(prepared.manifest.digest)},${json([{userId,role:'investigator'},{userId:reviewerId,role:'reviewer'}])});`);
          const investigator={tenantId,userId,role:'investigator'},reviewer={tenantId,userId:reviewerId,role:'reviewer'};
          const executeSql=async({statement,userId,role})=>{const response=await sql(statement,{userId,role,allowFailure:true});if(response.code!==0)throw Object.assign(new Error('Local evaluation SQL rejected.'),{sqlState:response.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1]});const text=response.stdout.trim();return text?JSON.parse(text):null;};
          const repositoryForSession=profile=>createLocalPostgresRuntime({executeSql,tenantId,profile});
          const observer=createLocalObserver({filePath:join(outputDir,packId+'.traces.jsonl'),runId:randomUUID(),projectName:'refund-office-runtime-evaluation',maxSpans:1024,maxBytes:2*1024*1024});
          const service=createRuntimeService({repositoryForSession,workerRepository:repositoryForSession(investigator),automaticWorker:false,observer,packId});
          let intakeReplays=0;const observations=[];const networkBefore=externalRequests;
          try {
            for(const seed of dataset.cases){const replay=await service.intake(investigator,{eventId:`demo-${packId}-${seed.id}`,orderId:seed.orderId,complaint:seed.complaint});if(replay.replayed&&replay.case.id===seed.id)intakeReplays++;}
            for(let n=0;n<dataset.cases.length;n++){const result=await service.runNext(investigator);assert.ok(result.case?.id,'Queue ended before every expected case.');observations.push(await repositoryForSession(reviewer).readCase(result.case.id));}
            assert.deepEqual(await service.runNext(investigator),{empty:true});
            const workspace=await repositoryForSession(reviewer).readWorkspace();
            const counts=await value(`select jsonb_build_object('approvals',(select count(*) from refund_runtime.approvals where tenant_id=${uuid(tenantId)}),'newOperations',(select count(*) from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded),'paymentExecutions',(select count(*) from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)}));`);
            await observer.flush();const snapshot=observer.snapshot(),recorder=observer.status();
            const scorecard=buildRuntimeScorecard({dataset,observations,spans:snapshot.spans,counters:{...counts,intakeReplays,caseCount:workspace.cases.length,externalRequests:externalRequests-networkBefore},recorder});
            results.push({scorecard,snapshot,recorder});save(packId+'.bundle.json',snapshot);save(packId+'.scorecard.json',scorecard);
            assert.equal(scorecard.passed,true,JSON.stringify(scorecard.cases.filter(x=>!x.passed).map(x=>({case:x.caseLabel,failed:x.evaluations.filter(e=>!e.score).map(e=>e.name),observed:x.observedOutcome,amount:x.observedAmountMinor}))));
            return {cases:scorecard.summary.cases,checks:scorecard.summary.checks,spans:snapshot.spans.length,...counts,externalRequests:externalRequests-networkBefore};
          }finally{await service.close();}
        });
      }
    }});
  }catch(error){failure=error;}finally{globalThis.fetch=oldFetch;}
  const scorecards=results.map(x=>x.scorecard),spans=results.flatMap(x=>x.snapshot.spans);
  save('scorecards.json',scorecards);save('observed-cases.json',scorecards.flatMap(pack=>pack.cases.map(item=>({...item,packId:pack.dataset.id}))));
  save('traces.json',{schemaVersion:1,synthetic:true,uploaded:false,spans});save('index.html',renderRuntimeScorecards(scorecards,spans));
  let rowsPrepared=false;
  if(scorecards.length===PACKS.length){try{save('arize-evaluations.json',prepareRuntimeEvaluationRows(scorecards,spans));rowsPrepared=true;}catch(error){failure||=error;}}
  const after=sourceSnapshot();save('sources-after.json',after);
  const passed=!failure&&verification?.passed===true&&scorecards.length===PACKS.length&&scorecards.every(x=>x.passed)&&externalRequests===0&&rowsPrepared&&before.digest===after.digest;
  const manifest={schemaVersion:1,passed,synthetic:true,uploaded:false,runtime:'actual-createRuntimeService-local-postgresql',cases:scorecards.reduce((n,x)=>n+x.summary.cases,0),checks:scorecards.reduce((n,x)=>n+x.summary.checks,0),spans:spans.length,externalRequests,rowsPrepared,sourceUnchanged:before.digest===after.digest,sourceDigest:before.digest,databaseChecks:verification?.checks||0,failure:failure?.message||null,outputDir};
  save('manifest.json',manifest);if(!passed)throw new Error(`Current-runtime evaluation did not pass. Inspect ${join(outputDir,'manifest.json')}`);return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runRuntimeEvaluations().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
