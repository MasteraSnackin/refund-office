import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APPLICATION_ARCHIVE_NAME, APPLICATION_ROOT_FILES, APPLICATION_SOURCE_DIRECTORIES, FINAL_STATUS, VERIFICATION_DOCUMENT, collectApplicationSources, prepareSponsorApplication, verifySponsorApplicationArchive } from '../scripts/prepare-sponsor-application.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'refund-application-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  for (const path of APPLICATION_SOURCE_DIRECTORIES) mkdirSync(join(root, path), { recursive: true });
  for (const path of APPLICATION_ROOT_FILES) put(path, path.endsWith('.json') ? '{}' : '# Local source\n');
  put('package.json', json({ name: 'refund-office', dependencies: { react: '19.2.0' } }));
  put('package-lock.json', json({ name: 'refund-office', lockfileVersion: 3, packages: { '': { name: 'refund-office', dependencies: { react: '19.2.0' } } } }));
  put('.env.example', 'REFUND_OFFICE_NETWORK=offline\nOPENAI_API_KEY=\n');
  put('integrations/.env.example', 'REFUND_OFFICE_NETWORK=offline\nELEVENLABS_API_KEY=\nELEVENLABS_VOICE_ID=\n');
  put('integrations/vercel/hosted.env.example', 'REFUND_OFFICE_NETWORK=offline\nREFUND_OFFICE_HOSTED=disabled\nREFUND_OFFICE_SESSION_SECRET=\n');
  put('.npmrc', 'fund=false\naudit=false\n');
  put('src/main.jsx', 'export const fixture = true;\n');
  put('server/fixture.mjs', 'export const offline = true;\n');
  put('tests/sponsor-session-ui.test.mjs', 'export const sessionExpiryTest = true;\n');
  put('.openai/hosting.json', '{"version":1}\n');
  put('launchers/Focused demo.command', '#!/bin/zsh\ncd -- "$(dirname -- "$0")/.."\nnpm run demo:focused\n');
  chmodSync(join(root, 'launchers/Focused demo.command'), 0o755);
  put(VERIFICATION_DOCUMENT, '# Sponsor application verification\n\n' + FINAL_STATUS + '\n\nSynthetic test fixture only.\n');
  const migrations = ['001_runtime.sql', '002_office_workflow.sql', '003_hosted_access.sql', '004_payment_execution.sql', '005_sponsor_actions.sql'];
  for (const name of migrations) put('integrations/supabase/runtime/' + name, '-- Fixture ' + name + '\n');
  const sourceFiles = ['server/fixture.mjs', ...migrations.map(name => 'integrations/supabase/runtime/' + name)].sort((a, b) => a.localeCompare(b)).map(path => {
    const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) };
  });
  const snapshot = { algorithm: 'sha256', digest: hash(JSON.stringify(sourceFiles)), files: sourceFiles };
  const database = { network: 'none', localUnixSocket: true, existingDataMounts: false, cleanedUp: true, containerId: 'PRIVATE-CONTAINER-ID-DO-NOT-PACK' };
  const evidenceBase = 'work/sponsor-wiring/database/runs/fixture';
  const evidence = { verification: join(root, evidenceBase, 'verification.json'), sourcesBefore: join(root, evidenceBase, 'sources-before.json'), sourcesAfter: join(root, evidenceBase, 'sources-after.json') };
  put(evidenceBase + '/sources-before.json', json(snapshot)); put(evidenceBase + '/sources-after.json', json(snapshot));
  put(evidenceBase + '/verification.json', json({ passed: true, fatal: null, database, checks: Array.from({ length: 41 }, () => ({ passed: true, detail: 'PRIVATE-RAW-DETAIL' })) }));
  const combined = { passed: true, sourceUnchanged: true, fatal: null, completedAt: '2026-10-14T17:33:21.408Z', evidence,
    sourceDigest: snapshot.digest, sourceFiles: sourceFiles.length, checks: { total: 41, passed: 41, failed: 0, base: 20, workflow: 7, payment: 8, hosted: 6 },
    database, sqlRoundTrips: 607, expectedRejections: 142,
    migrationHashes: Object.fromEntries(sourceFiles.filter(file => file.path.endsWith('.sql')).map(file => [file.path, file.sha256])) };
  put(evidenceBase + '/combined-verification.json', json(combined));
  put('work/sponsor-wiring/database/latest.json', json({ passed: true, evidence: join(root, evidenceBase, 'combined-verification.json') }));
  return { root, projectDir: root, put, outputDir: join(root, 'work/package-test'), combined, evidenceBase };
}

test('source archive reopens with exact hashes, executable launchers, blank templates and sanitised current evidence', t => {
  const f = fixture(t);
  const poisoned = 'PRIVATE-EXCLUDED-DATA';
  for (const path of ['.env', '.data/cases.sqlite', 'work/session.json', 'node_modules/module.js', 'dist/output.js', 'migration-prep/archive.json', 'handover/archive.json', 'deliverables/old.zip', 'server/__pycache__/module.pyc', 'public/.DS_Store']) f.put(path, poisoned);
  const priorFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = () => { requests++; throw new Error('No network permitted'); };
    const result = prepareSponsorApplication(f);
    assert.equal(requests, 0);
    assert.equal(result.archivePath, join(f.outputDir, APPLICATION_ARCHIVE_NAME));
    assert.equal(result.archiveFiles, result.manifest.files.length + 1);
    assert.equal(hash(readFileSync(result.archivePath)), result.sha256);
    assert.match(readFileSync(result.checksumPath, 'utf8'), new RegExp('^' + result.sha256));
    assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')), result.manifest);
    const paths = result.manifest.files.map(file => file.path);
    for (const path of paths) assert.ok(!/(?:^|\/)(?:\.data|work|node_modules|dist|migration-prep|handover|deliverables|__pycache__)(?:\/|$)/.test(path), path);
    assert.ok(paths.includes(VERIFICATION_DOCUMENT));
    assert.ok(paths.includes('integrations/vercel/hosted.env.example'));
    assert.equal(result.manifest.files.find(file => file.path === 'launchers/Focused demo.command').mode, 0o755);
    assert.deepEqual(verifySponsorApplicationArchive({ archivePath: result.archivePath, manifest: result.manifest }), { verified: true, files: result.archiveFiles });
    const inspect = spawnSync('python3', ['-B', '-c', 'import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"summary":json.loads(z.read("verification/sponsor-database-summary.json")),"template":z.read(".env.example").decode(),"launcher":z.read("launchers/Focused demo.command").decode()}))', result.archivePath], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.ok(!inspect.stdout.includes('PRIVATE-') && !inspect.stdout.includes(f.root));
    const saved = JSON.parse(inspect.stdout);
    assert.equal(saved.summary.checks.passed, 41);
    assert.equal(saved.summary.isolation.cleanedUp, true);
    assert.equal(saved.template, readFileSync(join(f.root, '.env.example'), 'utf8'));
    assert.match(saved.launcher, /dirname/);
    assert.equal(readFileSync(join(f.root, 'deliverables/old.zip'), 'utf8'), poisoned);
  } finally { globalThis.fetch = priorFetch; }
});

test('draft verification documents and stale database evidence cannot produce an archive', t => {
  const f = fixture(t);
  f.put(VERIFICATION_DOCUMENT, '# Verification\n\nStatus: draft.\n');
  assert.throws(() => prepareSponsorApplication(f), /final passed status/);
  assert.equal(existsSync(f.outputDir), false);
  f.put(VERIFICATION_DOCUMENT, '# Verification\n\n' + FINAL_STATUS + '\n');
  f.put('server/fixture.mjs', 'export const changed = true;\n');
  assert.throws(() => prepareSponsorApplication(f), /stale/);
  assert.equal(existsSync(f.outputDir), false);
});

test('failed checks and missing cleanup cannot be presented as passed local verification', t => {
  const f = fixture(t);
  f.combined.checks.hosted = 5;
  f.put(f.evidenceBase + '/combined-verification.json', json(f.combined));
  assert.throws(() => prepareSponsorApplication(f), /counts are incomplete/);
  f.combined.checks.hosted = 6; f.combined.database.cleanedUp = false;
  f.put(f.evidenceBase + '/combined-verification.json', json(f.combined));
  assert.throws(() => prepareSponsorApplication(f), /completed cleanup/);
  assert.equal(existsSync(f.outputDir), false);
});

test('filled templates, unexpected private files, credentials and unsafe npm configuration are refused', t => {
  const f = fixture(t);
  f.put('.env.example', 'REFUND_OFFICE_NETWORK=offline\nOPENAI_API_KEY=private-value\n');
  assert.throws(() => prepareSponsorApplication(f), /filled or unsafe/);
  f.put('.env.example', 'REFUND_OFFICE_NETWORK=offline\nOPENAI_API_KEY=\n');
  f.put('integrations/credentials.json', '{"private":true}');
  assert.throws(() => prepareSponsorApplication(f), /Unexpected private file/);
  rmSync(join(f.root, 'integrations/credentials.json'));
  f.put('server/leaked.mjs', 'export const value="' + 'sk_live_' + 'a'.repeat(32) + '";');
  assert.throws(() => prepareSponsorApplication(f), /Credential-like material/);
  rmSync(join(f.root, 'server/leaked.mjs'));
  f.put('.npmrc', '//registry.npmjs.org/:_authToken=private-value\n');
  assert.throws(() => prepareSponsorApplication(f), /credential-free npm/);
  assert.equal(existsSync(f.outputDir), false);
});

test('symlinks and nonportable launchers are refused without following them', t => {
  const f = fixture(t);
  symlinkSync(join(f.root, 'README.md'), join(f.root, 'server/linked.mjs'));
  assert.throws(() => collectApplicationSources(f.root), /Symbolic links/);
  rmSync(join(f.root, 'server/linked.mjs'));
  f.put('launchers/Focused demo.command', '#!/bin/zsh\ncd /Users/private/project\n');
  assert.throws(() => prepareSponsorApplication(f), /relative to their own/);
  assert.equal(existsSync(f.outputDir), false);
});

test('lockfile mismatch, overwritten archives and altered ZIP contents are rejected', t => {
  const f = fixture(t);
  const original = readFileSync(join(f.root, 'package-lock.json'));
  f.put('package-lock.json', '{"name":"different"}');
  assert.throws(() => prepareSponsorApplication(f), /dependency lock/);
  f.put('package-lock.json', original);
  const result = prepareSponsorApplication(f), before = hash(readFileSync(result.archivePath));
  assert.throws(() => prepareSponsorApplication(f), /Refusing to overwrite/);
  assert.equal(hash(readFileSync(result.archivePath)), before);
  const mutate = spawnSync('python3', ['-B', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],"a");z.writestr("unexpected.txt","extra");z.close()', result.archivePath], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(mutate.status, 0, mutate.stderr);
  assert.throws(() => verifySponsorApplicationArchive({ archivePath: result.archivePath, manifest: result.manifest }), /Archive inventory differs/);
});
