import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSyntheticImport, exportSqliteSnapshot, contentHash } from '../server/supabase-import.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };
export const RUNTIME_SOURCE_FILES = Object.freeze([
  'demo-data/focused-12.json', 'demo-data/busy-50.json',
  'integrations/supabase/runtime/001_runtime.sql', 'integrations/supabase/runtime/CONTRACT.md',
  'server/supabase-runtime-repository.mjs', 'server/supabase-import.mjs', 'server/demo-dataset.mjs',
  'server/providers.mjs', 'server/claim-language.mjs', 'server/claude-investigator.mjs', 'server/investigation-proposal.mjs', 'server/evidence-clarification.mjs',
  'server/store.mjs', 'server/engine.mjs', 'server/fixtures.mjs',
  'scripts/prepare-supabase-runtime.mjs', 'scripts/test-supabase-runtime.mjs',
  'tests/supabase-runtime/bootstrap.sql', 'tests/supabase-runtime/checks.mjs',
  'tests/supabase-import.test.mjs', 'tests/supabase-runtime-repository.test.mjs',
  'package.json', 'docs/SUPABASE-RUNTIME.md', 'docs/SUPABASE-MIGRATION.md', 'docs/verification-supabase-runtime-2026-10-14.md',
]);

function safePath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('Symbolic links are not permitted in migration preparation paths.');
    if (dirname(current) === current) break;
  }
}
function sourceFile(projectDir, path) {
  if (!RUNTIME_SOURCE_FILES.includes(path)) fail('The migration source is not allowlisted.');
  const target = resolve(projectDir, path); safePath(target);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('Migration preparation inputs must be regular files no larger than two MiB.');
  return readFileSync(target);
}
function writeBundle(outputDir, kind, content, sourceMetadata = new Map()) {
  outputDir = resolve(outputDir); safePath(outputDir);
  const entries = [...content.entries()].sort(([a], [b]) => a.localeCompare(b));
  const paths = entries.map(([path]) => path);
  if (paths.some(path => !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(x => !x || x === '..' || x === '.'))) fail('Invalid generated migration path.');
  const manifestPath = resolve(outputDir, 'manifest.json');
  let prior = null;
  if (existsSync(manifestPath)) {
    safePath(manifestPath);
    prior = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (prior.kind !== kind || prior.schemaVersion !== 1 || !Array.isArray(prior.files)) fail('The previous migration manifest is not recognised.');
    if (prior.files.length !== paths.length || prior.files.some(file => !paths.includes(file.path))) fail('The prior migration file list differs; preserve it and choose a new output directory.');
  }
  for (const path of paths) {
    const target = resolve(outputDir, path); safePath(target);
    if (existsSync(target)) {
      const known = prior?.files.find(file => file.path === path);
      if (!known || !lstatSync(target).isFile() || contentHash(readFileSync(target)) !== known.sha256) fail('Refusing to overwrite a changed or unrecognised migration preparation file.');
    } else if (prior) fail('A previous migration preparation file is missing; preserve the remaining output before regeneration.');
  }
  const manifest = { kind, schemaVersion: 1, mode: 'offline-preparation', connected: false, applied: false, standaloneApplication: false,
    files: entries.map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: contentHash(bytes), ...(sourceMetadata.get(path) || {}) })) };
  for (const [path, bytes] of [...entries, ['manifest.json', json(manifest)]]) {
    const destination = resolve(outputDir, path); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = destination + '.migration-tmp';
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination);
  }
  return { outputDir, manifest };
}

export function prepareSupabaseRuntime({ projectDir = projectRoot, outputDir = resolve(projectDir, 'migration-prep') } = {}) {
  const content = new Map();
  // Add-on source only. Never recurse into a directory or copy snapshot output.
  for (const path of RUNTIME_SOURCE_FILES) content.set(path, sourceFile(projectDir, path));
  const packs = [];
  for (const id of ['focused-12', 'busy-50']) {
    const input = sourceFile(projectDir, `demo-data/${id}.json`);
    const pack = prepareSyntheticImport(JSON.parse(input));
    packs.push(pack);
    content.set(`${id}/data.json`, json(pack.data));
    content.set(`${id}/import.sql`, pack.sql);
    content.set(`${id}/mapping-manifest.json`, json({ ...pack.manifest, sourceFile: `demo-data/${id}.json`, sourceSha256: contentHash(input) }));
  }
  content.set('schema/001_runtime.sql', sourceFile(projectDir, 'integrations/supabase/runtime/001_runtime.sql'));
  content.set('schema/CONTRACT.md', sourceFile(projectDir, 'integrations/supabase/runtime/CONTRACT.md'));
  content.set('README.md', '# Synthetic runtime migration preparation\n\nThese files prepare two synthetic datasets for the separate [runtime schema](schema/001_runtime.sql). Nothing has been applied to a database or sent online. The application still uses SQLite. The schema and import are separate from the existing decision-packet archive.\n\n| Pack | Tenant UUID | Cases | Orders |\n| --- | --- | --- | --- |\n' + packs.map(pack => `| [${pack.datasetId}](${pack.datasetId}/mapping-manifest.json) | ${pack.tenantId} | ${pack.data.cases.length} | ${pack.data.orders.length} |`).join('\n') + '\n\nEach pack has deterministic `data.json`, `import.sql` and a mapping manifest. The SQL calls the restricted `refund_runtime_import_dataset` function inside a transaction. It supplies no members, authenticated reviewers or approvals. Fresh cases begin ready for investigation. Seeded historical local remedies remain succeeded history and cannot be submitted. They preserve duplicate detection without inventing retrospective human approval.\n\nFollow the [runtime contract](schema/CONTRACT.md). A later authorised migration operator must apply the schema to a separate synthetic-only database before running an import. The same tenant and dataset digest is intended to be replay-safe; conflicting data must be rejected. The fixed UUIDs identify fictional staging tenants, not real customers or accounts. No command here logs in or applies SQL.\n\nThe complete project provides `node scripts/prepare-supabase-runtime.mjs` to regenerate these files. Changed generated files are preserved by refusing an overwrite. Unrelated output files are left alone.\n\nFor an explicitly selected existing SQLite file, the complete project also provides `node scripts/prepare-supabase-runtime.mjs --snapshot /absolute/path/to/cases.sqlite`. There is no default source database. This verifies and reads a private temporary copy in a read-only transaction, does not write source database or sidecar files and does not invoke startup recovery and writes a separate quarantined snapshot under `migration-prep/snapshots/`. It preserves raw records, approval snapshots, fingerprints, operation IDs, original retry keys and receipts. A `local-reviewer` label is not an authenticated cloud identity: all exported approvals and operations remain archival and non-executable. Snapshot output cannot be fed to the synthetic importer. Keep private snapshots outside a shared sponsor pack.\n');
  content.set('README.md', '# Refund Office migration add-on\n\nThis is an additive preparation pack, not a standalone application. It contains the named runtime source, tests, offline PostgreSQL harness and synthetic inputs needed to review the migration work. It does not include the interface, installed dependencies or existing application history. Apply reviewed source changes to the complete matching Refund Office project; the included package manifest is context, not a claim that every app command runs from this pack.\n\nRead the [runtime guide](docs/SUPABASE-RUNTIME.md). The PostgreSQL harness is for an explicitly available, isolated local test environment; it must not connect to Supabase or download an uncached image. The original ten-sponsor handover remains a separate artifact. Private SQLite quarantine snapshots are excluded by the fixed source allowlist.\n\n' + content.get('README.md'));
  const sourceMetadata = new Map();
  for (const path of RUNTIME_SOURCE_FILES) {
    const source = content.get(path), externalReferences = [];
    if (path.endsWith('.md')) {
      const adapted = source.toString('utf8').replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, label, target) => {
        if (/^(https?:|#)/.test(target)) return match;
        const reference = posix.normalize(posix.join(posix.dirname(path), target.split('#')[0]));
        if (content.has(reference)) return match;
        externalReferences.push(reference);
        return `${label} (complete-project reference: \`${reference}\`)`;
      });
      if (externalReferences.length) content.set(path, adapted);
    }
    sourceMetadata.set(path, { sourcePath: path, sourceSha256: contentHash(source), ...(externalReferences.length ? { completeProjectReferences: externalReferences } : {}) });
  }
  return { ...writeBundle(outputDir, 'refund-office-synthetic-runtime-preparation', content, sourceMetadata), packs: packs.map(pack => pack.manifest) };
}

export function prepareSqliteQuarantine({ dbPath, outputBase = resolve(projectRoot, 'migration-prep', 'snapshots') } = {}) {
  const snapshot = exportSqliteSnapshot({ dbPath });
  const identity = contentHash(snapshot.manifest).slice(0, 24);
  const content = new Map([
    ['quarantine.json', json(snapshot)],
    ['README.md', '# Read-only SQLite quarantine snapshot\n\nThis export preserves source records as archival evidence. No record is executable or eligible for operational import. In particular, local reviewer approvals do not become authenticated cloud approvals. Original snapshots, fingerprints, operation identities, retry keys and receipts remain in the raw and parsed records.\n\nThe source was explicitly selected, copied after stable byte checks and read through a private copy in a read-only SQLite transaction. The selected source directory was not written. Startup recovery, seeding and migration were not run. The export refuses known credential fields and credential-like values. Treat the contents as private source records and review before sharing. This directory is not included by the sponsor handover allowlist.\n'],
  ]);
  return { ...writeBundle(resolve(outputBase, identity), 'refund-office-quarantined-snapshot-files', content), snapshotManifest: snapshot.manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) {
      const result = prepareSupabaseRuntime();
      console.log(`Prepared ${result.packs.length} synthetic runtime imports in ${result.outputDir}. No database was opened or applied.`);
    } else if (args.length === 2 && args[0] === '--snapshot') {
      const result = prepareSqliteQuarantine({ dbPath: args[1] });
      console.log(`Read-only snapshot saved to ${result.outputDir}. All source approvals and operations are quarantined and non-executable.`);
    } else fail('Use no arguments for synthetic preparation, or --snapshot with an explicit absolute SQLite file path.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
