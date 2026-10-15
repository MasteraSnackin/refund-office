import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = join(ROOT, 'work/evidence-loop/database');
const ENTRYPOINTS = [
  'scripts/test-evidence-loop.mjs',
  'scripts/test-supabase-runtime.mjs',
  'tests/runtime-workflow/checks.mjs',
  'tests/runtime-payments/checks.mjs',
  'tests/supabase-runtime/hosted-checks.mjs',
  'tests/runtime-payments/review-checks.mjs',
  'tests/evidence-loop/checks.mjs',
  'scripts/run-evidence-rehearsal.mjs',
  'vite.evidence.config.mjs',
];
const INPUTS = [
  'tests/supabase-runtime/bootstrap.sql',
  'demo-data/focused-12.json',
  'demo-data/busy-50.json',
  ...['001_runtime.sql', '002_office_workflow.sql', '003_hosted_access.sql', '004_payment_execution.sql', '005_sponsor_actions.sql', '006_payment_review.sql', '007_evidence_clarification.sql']
    .map(name => 'integrations/supabase/runtime/' + name),
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

// Record the actual local import graph and every SQL/data input before loading
// application modules. Do not read environment credentials or archived bundles.
function snapshotSources() {
  const found = new Map();
  const visit = file => {
    const absolute = resolve(ROOT, file);
    assert.ok(absolute.startsWith(ROOT), 'Verification dependencies must stay inside the project.');
    const path = relative(ROOT, absolute);
    if (found.has(path)) return;
    const bytes = readFileSync(absolute);
    found.set(path, { path, bytes: bytes.length, sha256: sha256(bytes) });
    if (!/\.[cm]?js$/.test(path)) return;
    for (const match of bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      visit(relative(ROOT, resolve(dirname(absolute), match[1])));
    }
  };
  for (const path of [...ENTRYPOINTS, ...INPUTS]) visit(path);
  const files = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { algorithm: 'sha256', digest: sha256(JSON.stringify(files)), files };
}

export async function runEvidenceLoopApplicationChecks() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const outputDir = join(OUTPUT, 'runs', runId);
  mkdirSync(outputDir, { recursive: true });
  const before = snapshotSources();
  writeJson(join(outputDir, 'sources-before.json'), before);
  const suites = [];
  let result = null, fatal = null, after = null;
  try {
    const { runSupabaseRuntimeChecks } = await import('./test-supabase-runtime.mjs');
    const { runWorkflowChecks } = await import('../tests/runtime-workflow/checks.mjs');
    const { runPaymentChecks } = await import('../tests/runtime-payments/checks.mjs');
    const { runHostedChecks } = await import('../tests/supabase-runtime/hosted-checks.mjs');
    const { runPaymentReviewChecks } = await import('../tests/runtime-payments/review-checks.mjs');
    const { runEvidenceLoopChecks } = await import('../tests/evidence-loop/checks.mjs');
    result = await runSupabaseRuntimeChecks({ outputDir, additionalChecks: async harness => {
      // 001 is installed by the base checks. Workflow installs 002; payment
      // reuses 002 and adds 004; hosted adds 003 and 005 to this same database.
      // Review adds read-only 006. No suite receives a preview connection or a provider network client.
      for (const [name, run] of [['workflow', runWorkflowChecks], ['payment', runPaymentChecks], ['hosted', runHostedChecks], ['payment-review', runPaymentReviewChecks], ['evidence-loop', runEvidenceLoopChecks]]) {
        const suite = { name, passed: false, checks: 0 };
        suites.push(suite);
        await run({ ...harness, check: async (title, action) => {
          await harness.check(title, action);
          suite.checks++;
        } });
        suite.passed = true;
      }
    } });
  } catch (error) {
    fatal = error.message;
  } finally {
    try {
      after = snapshotSources();
      writeJson(join(outputDir, 'sources-after.json'), after);
      if (before.digest !== after.digest) fatal = [fatal, 'Source files changed during verification; rerun the combined check.'].filter(Boolean).join(' ');
    } catch (error) {
      fatal = [fatal, 'Source snapshot failed: ' + error.message].filter(Boolean).join(' ');
    }
    const verificationPath = join(outputDir, 'verification.json');
    const verification = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : null;
    const additionalChecks = suites.reduce((total, suite) => total + suite.checks, 0);
    const passedChecks = verification?.checks.filter(check => check.passed).length || 0;
    const checks = { total: verification?.checks.length || 0, passed: passedChecks,
      failed: verification?.checks.filter(check => !check.passed).length || 0,
      base: passedChecks - additionalChecks,
      workflow: suites.find(suite => suite.name === 'workflow')?.checks || 0,
      payment: suites.find(suite => suite.name === 'payment')?.checks || 0,
      hosted: suites.find(suite => suite.name === 'hosted')?.checks || 0,
      paymentReview: suites.find(suite => suite.name === 'payment-review')?.checks || 0,
      evidenceLoop: suites.find(suite => suite.name === 'evidence-loop')?.checks || 0 };
    const record = { schemaVersion: 1, runId, completedAt: new Date().toISOString(),
      passed: !fatal && result?.passed === true && verification?.passed === true && verification?.database.cleanedUp === true,
      scope: 'One disposable, cached local PostgreSQL container with no network, published ports or existing data mounts. All seven migrations coexist; provider actions are injected fixtures and identities use a test-only auth.uid stub. No Supabase account, JWT verification, real provider API, live Stripe call or existing preview database is tested.',
      migrationApplicationOrder: ['001_runtime.sql', '002_office_workflow.sql', '004_payment_execution.sql', '003_hosted_access.sql', '005_sponsor_actions.sql', '006_payment_review.sql', '007_evidence_clarification.sql'],
      suiteOrder: ['base', 'workflow', 'payment', 'hosted', 'payment-review', 'evidence-loop'], checks, suites,
      sqlRoundTrips: verification?.execution.sqlRoundTrips || 0,
      expectedRejections: verification?.execution.expectedFailures.length || 0,
      database: verification?.database || null,
      sourceFiles: before.files.length, sourceDigest: before.digest,
      sourceUnchanged: after?.digest === before.digest,
      migrationHashes: Object.fromEntries(before.files.filter(file => /^integrations\/supabase\/runtime\/\d.*\.sql$/.test(file.path)).map(file => [file.path, file.sha256])),
      evidence: { verification: verificationPath, sourcesBefore: join(outputDir, 'sources-before.json'), sourcesAfter: join(outputDir, 'sources-after.json'), log: join(outputDir, 'execution.log') },
      fatal };
    writeJson(join(outputDir, 'combined-verification.json'), record);
    // Retain every run; only this small pointer changes on subsequent runs.
    writeJson(join(OUTPUT, 'latest.json'), { runId, passed: record.passed, evidence: join(outputDir, 'combined-verification.json') });
    if (!record.passed && !fatal) fatal = 'The combined verification or disposable-container cleanup did not complete.';
  }
  if (fatal) throw new Error(fatal);
  return { passed: true, checks: result.checks, evidence: join(outputDir, 'combined-verification.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvidenceLoopApplicationChecks().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
