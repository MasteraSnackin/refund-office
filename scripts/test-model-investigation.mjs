import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { runModelInvestigationChecks } from '../tests/model-investigation/checks.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
function snapshot() {
  const files = new Map();
  function visit(name) {
    const path = resolve(ROOT, name), key = relative(ROOT, path); if (!path.startsWith(ROOT) || files.has(key)) return;
    const data = readFileSync(path); files.set(key, { path: key, bytes: data.length, sha256: hash(data) });
    if (/\.[cm]?js$/.test(path)) for (const m of data.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(relative(ROOT, resolve(dirname(path), m[1])));
  }
  for (const name of ['scripts/test-model-investigation.mjs','demo-data/focused-12.json','demo-data/busy-50.json','tests/supabase-runtime/bootstrap.sql', ...['001_runtime.sql','002_office_workflow.sql','003_hosted_access.sql','004_payment_execution.sql','005_sponsor_actions.sql','006_payment_review.sql','007_evidence_clarification.sql','008_model_investigation.sql'].map(name=>'integrations/supabase/runtime/'+name)]) visit(name);
  const list = [...files.values()].sort((a,b)=>a.path.localeCompare(b.path)); return { digest: hash(JSON.stringify(list)), files: list };
}
const outputDir = join(ROOT,'work/model-investigation',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
mkdirSync(outputDir,{recursive:true});
const before = snapshot(); writeFileSync(join(outputDir,'sources-before.json'),JSON.stringify(before,null,2)+'\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('No real HTTP request is allowed in model investigation verification.'); };
let result, failure;
try { result = await runSupabaseRuntimeChecks({ additionalChecks: runModelInvestigationChecks, outputDir }); }
catch (error) { failure = error; }
finally { globalThis.fetch = originalFetch; }
const after = snapshot(); writeFileSync(join(outputDir,'sources-after.json'),JSON.stringify(after,null,2)+'\n');
const record = { passed: result?.passed === true && before.digest === after.digest && !failure, sourceUnchanged: before.digest === after.digest, sourceDigest:before.digest, checks:result?.checks, databaseVerification:join(outputDir,'verification.json'), scope:'Actual current service and PostgreSQL with injected OpenAI and Anthropic responses, independent database adverse checks, and 33 committed local-language scenarios. No live provider requests. No new approvals, operations or payment execution in this model test tenant. Separate legacy test fixtures exercise disabled reservations.', failure:failure?.message || null };
writeFileSync(join(outputDir,'model-verification.json'),JSON.stringify(record,null,2)+'\n');
if (!record.passed) throw failure || new Error('Model investigation verification or source preservation failed.');
console.log(JSON.stringify({...record,evidence:join(outputDir,'model-verification.json')}));
