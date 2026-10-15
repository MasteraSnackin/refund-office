import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { runRuntimeObservabilityChecks } from '../tests/runtime-observability/checks.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot() {
  const found = new Map();
  function visit(path) {
    const absolute = resolve(ROOT, path); assert.ok(absolute.startsWith(ROOT));
    path = relative(ROOT, absolute); if (found.has(path)) return;
    const bytes = readFileSync(absolute); found.set(path, { path, bytes: bytes.length, sha256: hash(bytes) });
    if (/\.[cm]?js$/.test(path)) for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(relative(ROOT, resolve(dirname(absolute), match[1])));
  }
  for (const path of ['scripts/test-runtime-observability.mjs', 'scripts/run-evidence-rehearsal.mjs', 'tests/supabase-runtime/bootstrap.sql', 'demo-data/focused-12.json', 'demo-data/busy-50.json', ...['001_runtime.sql', '002_office_workflow.sql', '003_hosted_access.sql', '004_payment_execution.sql', '005_sponsor_actions.sql', '006_payment_review.sql', '007_evidence_clarification.sql'].map(name => 'integrations/supabase/runtime/' + name)]) visit(path);
  const files = [...found.values()].sort((a, b) => a.path.localeCompare(b.path)); return { digest: hash(JSON.stringify(files)), files };
}
export async function runRuntimeObservabilityVerification() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const outputDir = join(ROOT, 'work/observability/postgres', runId); mkdirSync(outputDir, { recursive: true });
  const before = snapshot(); writeFileSync(join(outputDir, 'sources-before.json'), JSON.stringify(before, null, 2) + '\n');
  let result, failure;
  try { result = await runSupabaseRuntimeChecks({ outputDir, additionalChecks: harness => runRuntimeObservabilityChecks({ ...harness, outputDir }) }); }
  catch (error) { failure = error; }
  const after = snapshot(); writeFileSync(join(outputDir, 'sources-after.json'), JSON.stringify(after, null, 2) + '\n');
  const unchanged = before.digest === after.digest;
  const record = { passed: result?.passed === true && unchanged && !failure, checks: result?.checks, sourceUnchanged: unchanged, sourceDigest: before.digest, sourceFiles: before.files.length, databaseVerification: join(outputDir, 'verification.json'), traces: join(outputDir, 'runtime-traces.json'), scope: 'Actual newly invoked runtime operations in a disposable network-none PostgreSQL database. Seven migrations and synthetic data; the traced tenant has no approvals or new operations. Existing base checks exercise disabled reservations in separate test fixtures. No provider connection or payment submission. Identity uses a local test stub.', failure: failure?.message || (unchanged ? null : 'Source changed during the test.') };
  writeFileSync(join(outputDir, 'trace-verification.json'), JSON.stringify(record, null, 2) + '\n');
  if (!record.passed) throw failure || new Error(record.failure || 'Trace verification did not pass.');
  return { ...record, evidence: join(outputDir, 'trace-verification.json') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runRuntimeObservabilityVerification().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
