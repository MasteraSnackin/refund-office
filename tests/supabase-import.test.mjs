import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync, existsSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSyntheticImport, exportSqliteSnapshot, SYNTHETIC_TENANTS, canonicalJSON, contentHash } from '../server/supabase-import.mjs';
import { prepareSupabaseRuntime, prepareSqliteQuarantine, RUNTIME_SOURCE_FILES } from '../scripts/prepare-supabase-runtime.mjs';
import { createStore } from '../server/store.mjs';
import { createProviders } from '../server/providers.mjs';
import { createEngine } from '../server/engine.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pack = id => JSON.parse(readFileSync(resolve(projectDir, `demo-data/${id}.json`), 'utf8'));
function temp(t) {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'refund-import-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const files = dir => Object.fromEntries(readdirSync(dir).sort().map(path => [path, contentHash(readFileSync(resolve(dir, path)))]));

test('both synthetic imports are deterministic, correctly counted and contain no operational approval or member', () => {
  for (const [id, cases, orders, history] of [['focused-12',12,11,1],['busy-50',50,46,4]]) {
    const first = prepareSyntheticImport(pack(id));
    const second = prepareSyntheticImport(JSON.parse(canonicalJSON(pack(id))));
    assert.equal(first.sql, second.sql);
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(first.tenantId, SYNTHETIC_TENANTS[id]);
    assert.equal(first.manifest.counts.freshCases, cases);
    assert.equal(first.manifest.counts.orders, orders);
    assert.equal(first.manifest.counts.historicalLocalOperations, history);
    assert.equal(first.manifest.counts.approvals, 0);
    assert.equal(first.manifest.counts.members, 0);
    assert.equal(first.manifest.submissionEnabled, false);
    assert.ok(first.data.cases.every(item => !item.approval && !item.receipt && !item.operationId));
    assert.ok(first.manifest.mappings.historicalOperations.every(item => item.seeded && !item.executable));
    assert.match(first.sql, /BEGIN;\nSELECT public\.refund_runtime_import_dataset/);
    assert.match(first.sql, /p_members => '\[\]'::jsonb/);
    assert.equal(first.manifest.dataSha256, contentHash(canonicalJSON(first.data)));
    const delimiter = `$refund_dataset_${first.manifest.digest.slice(0,20)}$`;
    assert.deepEqual(JSON.parse(first.sql.split(delimiter)[1]), first.data);
  }
});

test('imports reject runtime state, unmarked data, altered money and credential-like content', () => {
  for (const alter of [data => { data.cases[0].approval = { state: 'approved' }; }, data => { data.synthetic = false; }, data => { data.orders[0].totalMinor++; }, data => { data.cases[0].complaint = 'Use secret sk_live_DoNotExportThisValue for the refund.'; }]) {
    const data = pack('focused-12'); alter(data);
    assert.throws(() => prepareSyntheticImport(data));
  }
});

test('snapshot preserves raw approval and operation identities without triggering startup recovery', async t => {
  const dir = temp(t), dbPath = resolve(dir, 'explicit.sqlite');
  const store = createStore({ dbPath, dataset: pack('focused-12') });
  const engine = createEngine({ store, provider: createProviders({ env: {}, fetchImpl: () => assert.fail('network') }) });
  let item = await engine.run(pack('focused-12').cases[0].id);
  for (let i = 0; item.status === 'running' && i < 12; i++) item = await engine.advance(item.id, { expectedRevision: item.revision });
  item = await engine.approve(item.id, { expectedRevision: item.revision, expectedAmountMinor: item.approval.amountMinor,
    fingerprint: item.approval.fingerprint, note: 'Synthetic test only: I approve the exact saved missing-item amount.' });
  const originalCase = store.db.prepare('SELECT data FROM cases WHERE id=?').get(item.id).data;
  const originalOperation = store.db.prepare('SELECT data FROM operations WHERE id=?').get(item.operationId).data;
  store.close();
  const before = files(dir);
  const snapshot = exportSqliteSnapshot({ dbPath });
  assert.deepEqual(files(dir), before, 'source bytes and sidecar inventory must remain untouched');
  const savedCase = snapshot.tables.cases.find(row => row.identity.id === item.id);
  const savedOperation = snapshot.tables.operations.find(row => row.identity.id === item.operationId);
  assert.equal(savedCase.rawData, originalCase);
  assert.equal(savedOperation.rawData, originalOperation);
  assert.equal(savedCase.data.status, 'running');
  assert.equal(savedCase.data.revision, item.revision);
  assert.deepEqual(savedOperation.data.approvalSnapshot, JSON.parse(originalOperation).approvalSnapshot);
  assert.equal(savedOperation.data.approval.fingerprint, item.approval.fingerprint);
  assert.equal(savedOperation.data.idempotencyKey, JSON.parse(originalOperation).idempotencyKey);
  assert.equal(savedOperation.data.receipt, null);
  assert.equal(snapshot.manifest.localReviewerApprovals, 1);
  assert.equal(snapshot.manifest.startupRecoveryRun, false);
  assert.equal(snapshot.manifest.sourceOpenedBySqlite, false);
  assert.equal(snapshot.manifest.operationalImportAllowed, false);
  assert.ok(snapshot.approvals.every(approval => approval.executable === false && /not an authenticated/.test(approval.reason)));
  assert.ok(Object.values(snapshot.tables).flat().every(row => row.disposition === 'archival-quarantine' && !row.executable));
  assert.deepEqual(exportSqliteSnapshot({ dbPath }), snapshot);
  assert.throws(() => prepareSyntheticImport(snapshot));
});

test('snapshot reads committed WAL content while leaving the open source and its sidecars unchanged', t => {
  const dir = temp(t), dbPath = resolve(dir, 'open-wal.sqlite');
  const store = createStore({ dbPath });
  t.after(() => store.close());
  const item = store.getCase('missing-item'); item.status = 'running'; item.revision = 55; store.saveCase(item);
  const before = files(dir);
  const snapshot = exportSqliteSnapshot({ dbPath });
  assert.equal(snapshot.tables.cases.find(row => row.identity.id === item.id).data.revision, 55);
  assert.equal(snapshot.tables.cases.find(row => row.identity.id === item.id).data.status, 'running');
  assert.deepEqual(files(dir), before);
  assert.equal(store.getCase(item.id).revision, 55);
});

test('snapshots require an explicit existing path, reject credential fields and never reveal their values', t => {
  assert.throws(() => exportSqliteSnapshot(), /explicit absolute path/);
  assert.throws(() => exportSqliteSnapshot({ dbPath: 'relative.sqlite' }), /explicit absolute path/);
  const dir = temp(t), missing = resolve(dir, 'missing.sqlite');
  assert.throws(() => exportSqliteSnapshot({ dbPath: missing }), /existing SQLite/);
  assert.equal(existsSync(missing), false);
  const dbPath = resolve(dir, 'credentials.sqlite');
  const store = createStore({ dbPath });
  store.db.prepare("INSERT INTO settings(key,data) VALUES('private-config',?)").run(JSON.stringify({ OPENAI_API_KEY: 'private-example-value' })); store.close();
  const before = files(dir);
  assert.throws(() => exportSqliteSnapshot({ dbPath }), error => /credential field/.test(error.message) && !error.message.includes('private-example-value'));
  assert.deepEqual(files(dir), before);
  const alias = resolve(dir, 'alias.sqlite'); symlinkSync(dbPath, alias);
  assert.throws(() => exportSqliteSnapshot({ dbPath: alias }), /without symbolic links/);
});

test('invalid source JSON fails without echoing its contents or changing source bytes', t => {
  const dir = temp(t), dbPath = resolve(dir, 'invalid.sqlite');
  const store = createStore({ dbPath });
  store.db.prepare("UPDATE cases SET data=? WHERE id='missing-item'").run('private-value-invalid-json'); store.close();
  const before = files(dir);
  assert.throws(() => exportSqliteSnapshot({ dbPath }), error => /invalid JSON/.test(error.message) && !error.message.includes('private-value'));
  assert.deepEqual(files(dir), before);
});

test('quarantine output preserves historical receipts and refuses changed generated files', t => {
  const dir = temp(t), dbPath = resolve(dir, 'source.sqlite');
  const store = createStore({ dbPath }); store.close();
  const result = prepareSqliteQuarantine({ dbPath, outputBase: resolve(dir, 'out') });
  const snapshot = JSON.parse(readFileSync(resolve(result.outputDir, 'quarantine.json'), 'utf8'));
  assert.equal(snapshot.tables.operations[0].data.receipt.id, 'DEMO-REMEDY-106');
  assert.equal(snapshot.tables.operations[0].data.idempotencyKey, 'refund-office-seed-106');
  assert.equal(snapshot.manifest.operationAmountsMinorByStatus.succeeded, 2000);
  prepareSqliteQuarantine({ dbPath, outputBase: resolve(dir, 'out') });
  writeFileSync(resolve(result.outputDir, 'README.md'), 'Personal note.');
  assert.throws(() => prepareSqliteQuarantine({ dbPath, outputBase: resolve(dir, 'out') }), /Refusing to overwrite/);
  assert.equal(readFileSync(resolve(result.outputDir, 'README.md'), 'utf8'), 'Personal note.');
});

test('runtime generator copies only allowlisted source files and protects changed output', async t => {
  const source = temp(t), outputDir = resolve(source, 'migration-prep');
  for (const path of RUNTIME_SOURCE_FILES) {
    mkdirSync(dirname(resolve(source, path)), { recursive: true });
    if (path.startsWith('demo-data/') || path.startsWith('server/')) cpSync(resolve(projectDir, path), resolve(source, path));
    else writeFileSync(resolve(source, path), path.endsWith('.sql') ? '-- Test schema placeholder, never applied.\n' : '# Test contract placeholder\n');
  }
  mkdirSync(resolve(source, '.data')); writeFileSync(resolve(source, '.data/private.sqlite'), 'private-must-not-copy');
  writeFileSync(resolve(source, '.env'), 'OPENAI_API_KEY=private-must-not-copy');
  writeFileSync(resolve(source, 'docs/SUPABASE-RUNTIME.md'), '# Runtime\n\n[Included source](../server/supabase-import.mjs) and [existing setup](ONLINE-SETUP.md).\n');
  const first = prepareSupabaseRuntime({ projectDir: source, outputDir });
  const packagedRepository = await import(pathToFileURL(resolve(outputDir, 'server/supabase-runtime-repository.mjs')).href);
  assert.ok(Object.keys(packagedRepository).length, 'packaged repository must resolve its own local dependencies');
  const second = prepareSupabaseRuntime({ projectDir: source, outputDir });
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.packs.length, 2);
  const guide = readFileSync(resolve(outputDir, 'docs/SUPABASE-RUNTIME.md'), 'utf8');
  assert.match(guide, /\[Included source\]\(\.\.\/server\/supabase-import\.mjs\)/);
  assert.match(guide, /existing setup \(complete-project reference: `docs\/ONLINE-SETUP\.md`\)/);
  assert.deepEqual(first.manifest.files.find(file => file.path === 'docs/SUPABASE-RUNTIME.md').completeProjectReferences, ['docs/ONLINE-SETUP.md']);
  assert.ok(first.manifest.files.every(file => !readFileSync(resolve(outputDir, file.path), 'utf8').includes('private-must-not-copy')));
  writeFileSync(resolve(outputDir, 'focused-12/import.sql'), '-- Personal edit\n');
  assert.throws(() => prepareSupabaseRuntime({ projectDir: source, outputDir }), /Refusing to overwrite/);
});
