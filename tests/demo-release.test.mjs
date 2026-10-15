import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RELEASE_EVIDENCE, RELEASE_ROOT_FILES, RELEASE_SOURCE_DIRECTORIES, collectDemoReleaseSources, prepareDemoRelease } from '../scripts/prepare-demo-release.mjs';
import { verifySponsorApplicationArchive } from '../scripts/prepare-sponsor-application.mjs';
import { renderRuntimeScorecards } from '../scripts/evaluate-runtime.mjs';
import { prepareRuntimeEvaluationRows, RUNTIME_EVALUATION_EXPLANATIONS } from '../server/runtime-evaluation-scorecard.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'refund-demo-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const path of RELEASE_SOURCE_DIRECTORIES) mkdirSync(join(root, path), { recursive: true });
  for (const path of RELEASE_ROOT_FILES) put(path, path.endsWith('.json') ? '{}' : '# Fixture source\n');
  put('package.json', json({ name: 'refund-office', dependencies: { react: '19.2.0' } }));
  put('package-lock.json', json({ name: 'refund-office', packages: { '': { name: 'refund-office', dependencies: { react: '19.2.0' } } } }));
  put('.env.example', 'REFUND_OFFICE_NETWORK=offline\nOPENAI_API_KEY=\n');
  put('integrations/.env.example', 'REFUND_OFFICE_NETWORK=offline\n');
  put('integrations/arize/.env.example', 'ARIZE_NETWORK_ENABLED=false\nARIZE_TRACE_UPLOAD_ENABLED=false\nARIZE_API_KEY=\nARIZE_PROJECT_NAME=refund-office-synthetic\n');
  put('integrations/vercel/hosted.env.example', 'REFUND_OFFICE_NETWORK=offline\nREFUND_OFFICE_HOSTED=disabled\nREFUND_OFFICE_SESSION_SECRET=\n');
  put('.npmrc', 'fund=false\naudit=false\n');
  put('.openai/hosting.json', '{}');
  put('server/current.mjs', 'export const source = "current synthetic fixture";\n');
  put('docs/RELEASE-HANDOVER.md', '# Guide\n');
  put('docs/business-validation/study.html', '<h1>Fixture study</h1>');
  put('docs/diagrams/local-observability.html', '<h1>Fixture map</h1>');
  put('docs/verification.md', '[Report](../' + RELEASE_EVIDENCE.runtime + '/index.html)\n[Old recording](../work/private-recording.mp4)\n[Guide](RELEASE-HANDOVER.md)\n');
  const source = readFileSync(join(root, 'server/current.mjs'));
  const entries = [{ path: 'server/current.mjs', bytes: source.length, sha256: hash(source) }];
  const snapshot = { digest: hash(JSON.stringify(entries)), files: entries };
  const isolation = { network: 'none', localUnixSocket: true, existingDataMounts: false, cleanedUp: true, containerId: 'DO-NOT-COPY-CONTAINER-ID' };
  for (const [kind, prefix] of Object.entries(RELEASE_EVIDENCE)) {
    put(prefix + '/sources-before.json', json(snapshot)); put(prefix + '/sources-after.json', json(snapshot));
    put(prefix + '/verification.json', json({ passed: true, fatal: null, startedAt: '2026-10-14T20:00:00Z', completedAt: '2026-10-14T20:01:00Z', scope: 'Synthetic fixture only', database: isolation, checks: Array.from({ length: kind === 'runtime' ? 22 : 26 }, (_, i) => ({ title: 'Synthetic check ' + i, passed: true, detail: 'DO-NOT-COPY-RAW-HISTORY' })) }));
  }
  const runtime = { schemaVersion: 1, passed: true, synthetic: true, uploaded: false, sourceUnchanged: true, sourceDigest: snapshot.digest, cases: 62, checks: 634, spans: 310, externalRequests: 0, databaseChecks: 22, failure: null, outputDir: join(root, RELEASE_EVIDENCE.runtime) };
  put(RELEASE_EVIDENCE.runtime + '/manifest.json', json(runtime));
  const spans = []; let serial = 0;
  const scorecards = [12, 50].map((n, i) => ({ kind: 'refund-office-runtime-scorecard', dataset: { id: i ? 'busy-50' : 'focused-12', cases: n }, synthetic: true, uploaded: false, passed: true, cases: Array.from({ length: n }, (_, c) => {
    serial++; const traceId = serial.toString(16).padStart(32, '0'), spanId = serial.toString(16).padStart(16, '0'), label = 'RF-' + serial;
    spans.push({ name: 'refund.investigation', status: 'OK', traceId, spanId, startTimeUnixNano: String(serial), attributes: { synthetic: true, packId: i ? 'busy-50' : 'focused-12', caseId: label, 'case.revision': 3, amountMinor: 2000, outcome: 'awaiting-approval' } });
    return { caseId: 'SYN-' + i + '-' + c, caseLabel: label, revision: 3, category: 'eligible-missing-item', observedAmountMinor: 2000, expectedAmountMinor: 2000, observedOutcome: 'awaiting-approval', expectedOutcome: 'awaiting-approval', evidenceRefs: [], passed: true, traceId, spanId, evaluations: Object.entries(RUNTIME_EVALUATION_EXPLANATIONS).map(([name, explanation]) => ({ name, explanation, score: 1, label: 'pass' })) };
  }), checks: Array.from({ length: 7 }, (_, c) => ({ name: 'fixture-check-' + c, score: 1, label: 'pass', explanation: 'Synthetic fixture' })), summary: { cases: n, passed: n, failed: 0, checks: i ? 507 : 127 }, limitations: ['Synthetic fixture only'], counters: { approvals: 0, newOperations: 0, paymentExecutions: 0, externalRequests: 0 } }));
  for (let i = spans.length; i < 310; i++) spans.push({ traceId: (i + 1000).toString(16).padStart(32, '0'), spanId: (i + 1000).toString(16).padStart(16, '0'), name: 'refund.intake', startTimeUnixNano: String(i), status: 'OK', attributes: { synthetic: true } });
  put(RELEASE_EVIDENCE.runtime + '/scorecards.json', json(scorecards));
  put(RELEASE_EVIDENCE.runtime + '/observed-cases.json', json(scorecards.flatMap(card => card.cases.map(c => ({ ...c, packId: card.dataset.id })))));
  put(RELEASE_EVIDENCE.runtime + '/traces.json', json({ synthetic: true, uploaded: false, spans }));
  put(RELEASE_EVIDENCE.runtime + '/arize-evaluations.json', json(prepareRuntimeEvaluationRows(scorecards, spans)));
  put(RELEASE_EVIDENCE.runtime + '/index.html', renderRuntimeScorecards(scorecards, spans));
  put(RELEASE_EVIDENCE.model + '/model-verification.json', json({ passed: true, sourceUnchanged: true, sourceDigest: snapshot.digest, checks: 26, failure: null, databaseVerification: join(root, RELEASE_EVIDENCE.model, 'verification.json'), scope: 'Controlled synthetic fixture' }));
  return { root, put, runtime, scorecards, projectDir: root, outputDir: join(root, 'deliverables/releases'), releaseId: '2026-10-14T21-00-00-000Z-test' };
}

test('dated release has a checked exact inventory and portable recorded evidence, without private histories or network use', t => {
  const f = fixture(t);
  for (const path of ['.data/saved.sqlite', 'work/private-recording.mp4', 'deliverables/old.zip', 'node_modules/old.js']) f.put(path, 'DO-NOT-COPY-PRIVATE-DATA');
  const previousFetch = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = () => { requests++; throw new Error('No requests allowed'); };
    const result = prepareDemoRelease(f);
    assert.equal(requests, 0);
    assert.equal(result.manifest.cleanExtractionCheck.status, 'pending-separate-verification');
    assert.equal(result.manifest.recordedEvidence.runtime.checks, 634);
    assert.equal(result.manifest.recordedEvidence.model.checkGroups, 26);
    assert.equal(hash(readFileSync(result.archivePath)), result.sha256);
    assert.deepEqual(verifySponsorApplicationArchive({ archivePath: result.archivePath, manifest: result.manifest }), { verified: true, files: result.archiveFiles });
    const inspect = spawnSync('python3', ['-B', '-c', 'import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({p:z.read(p).decode() for p in ["START-HERE.md","docs/verification.md","ARTIFACTS.md","recorded-evidence/runtime/manifest.json","recorded-evidence/runtime/database-summary.json","recorded-evidence/model/manifest.json"]}))', result.archivePath], { encoding: 'utf8' });
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.ok(!inspect.stdout.includes('DO-NOT-COPY') && !inspect.stdout.includes(f.root));
    const saved = JSON.parse(inspect.stdout);
    assert.match(saved['docs/verification.md'], /\.\.\/recorded-evidence\/runtime\/index.html/);
    assert.match(saved['docs/verification.md'], /\.\.\/ARTIFACTS.md#artifact-/);
    assert.match(saved['ARTIFACTS.md'], /Status: not included/);
    assert.match(saved['START-HERE.md'], /\[the artifact catalogue\]\(ARTIFACTS.md\)/);
    assert.doesNotMatch(saved['ARTIFACTS.md'], /`ARTIFACTS.md`/);
    assert.match(readFileSync(join(f.root, 'docs/verification.md'), 'utf8'), /work\/private-recording.mp4/);
    assert.equal(readFileSync(join(f.root, 'deliverables/old.zip'), 'utf8'), 'DO-NOT-COPY-PRIVATE-DATA');
    assert.ok(result.manifest.files.find(file => file.path === 'docs/verification.md').sourceSha256);
    assert.ok(result.manifest.files.every(file => !/^(?:\.data|work|node_modules|deliverables)\//.test(file.path)));
    assert.throws(() => prepareDemoRelease(f), /overwrite/);
  } finally { globalThis.fetch = previousFetch; }
});

test('changed checked sources, failed checks and enabled evaluation boundaries stop release publication', t => {
  const f = fixture(t);
  f.put('server/current.mjs', 'export const changed = true;');
  assert.throws(() => prepareDemoRelease(f), /stale/);
  assert.equal(existsSync(f.outputDir), false);
  f.put('server/current.mjs', 'export const source = "current synthetic fixture";\n');
  f.runtime.passed = false; f.put(RELEASE_EVIDENCE.runtime + '/manifest.json', json(f.runtime));
  assert.throws(() => prepareDemoRelease(f), /evaluation is incomplete/);
  f.runtime.passed = true; f.put(RELEASE_EVIDENCE.runtime + '/manifest.json', json(f.runtime));
  f.scorecards[0].counters.approvals = 1; f.put(RELEASE_EVIDENCE.runtime + '/scorecards.json', json(f.scorecards));
  assert.throws(() => prepareDemoRelease(f), /offline boundaries/);
  assert.equal(existsSync(f.outputDir), false);
});

test('filled templates and symlinked sources cannot enter a release', t => {
  const f = fixture(t);
  f.put('integrations/arize/.env.example', 'ARIZE_NETWORK_ENABLED=true\nARIZE_TRACE_UPLOAD_ENABLED=false\n');
  assert.throws(() => collectDemoReleaseSources(f.root), /blank credentials and safe offline defaults/);
  f.put('integrations/arize/.env.example', 'ARIZE_NETWORK_ENABLED=false\nARIZE_TRACE_UPLOAD_ENABLED=false\nARIZE_API_KEY=filled-test-value\n');
  assert.throws(() => collectDemoReleaseSources(f.root), /blank credentials and safe offline defaults/);
  f.put('integrations/arize/.env.example', 'ARIZE_NETWORK_ENABLED=false\nARIZE_TRACE_UPLOAD_ENABLED=false\n');
  symlinkSync(join(f.root, 'server/current.mjs'), join(f.root, 'src/symlink.mjs'));
  assert.throws(() => collectDemoReleaseSources(f.root), /symbolic links/);
});

test('stale lock and local private files in otherwise public source directories are refused', t => {
  const f = fixture(t);
  f.put('package-lock.json', '{}');
  assert.throws(() => collectDemoReleaseSources(f.root), /dependency lock differs/);
  f.put('package-lock.json', json({ name: 'refund-office', packages: { '': { name: 'refund-office', dependencies: { react: '19.2.0' } } } }));
  f.put('public/browser-cookie.json', '{}');
  assert.throws(() => collectDemoReleaseSources(f.root), /Unexpected private file/);
});

test('altered report HTML or evaluation rows cannot travel as verified derived outputs', t => {
  const f = fixture(t), htmlPath = RELEASE_EVIDENCE.runtime + '/index.html';
  const original = readFileSync(join(f.root, htmlPath), 'utf8');
  f.put(htmlPath, original + '<p>Unrecorded claim</p>');
  assert.throws(() => prepareDemoRelease(f), /derived outputs differ/);
  f.put(htmlPath, original);
  const rowsPath = RELEASE_EVIDENCE.runtime + '/arize-evaluations.json';
  const rows = JSON.parse(readFileSync(join(f.root, rowsPath)));
  rows.rows[0]['eval.case_identity.explanation'] = 'Unrecorded explanation';
  f.put(rowsPath, json(rows));
  assert.throws(() => prepareDemoRelease(f), /derived outputs differ/);
  assert.equal(existsSync(f.outputDir), false);
});

test('recognisable Anthropic credentials outside environment templates are refused', t => {
  const f = fixture(t);
  f.put('docs/config.json', json({ providerKey: 'sk-ant-' + 'x'.repeat(32) }));
  assert.throws(() => collectDemoReleaseSources(f.root), /Credential-like material/);
});
