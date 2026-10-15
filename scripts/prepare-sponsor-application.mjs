import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const APPLICATION_ARCHIVE_NAME = 'refund-office-sponsor-application-prep.zip';
export const VERIFICATION_DOCUMENT = 'docs/verification-sponsor-wiring-2026-10-14.md';
export const FINAL_STATUS = 'Status: passed locally. Sponsor accounts remain disconnected.';
export const APPLICATION_SOURCE_DIRECTORIES = Object.freeze(['src', 'server', 'api', 'scripts', 'tests', 'integrations', 'demo-data', 'public', 'worker', '.openai', 'docs', 'launchers']);
export const APPLICATION_ROOT_FILES = Object.freeze(['package.json', 'package-lock.json', 'vite.config.mjs', 'vite.runtime.config.mjs', 'index.html', 'README.md', 'ARCHITECTURE.md', 'AGENTS.md', 'design-qa.md', '.env.example', '.npmrc', '.gitignore']);
const TEMPLATES = new Set(['.env.example', 'integrations/.env.example', 'integrations/vercel/hosted.env.example']);
// This reviewed source test covers session expiry; it contains test logic,
// not exported browser/session data. Credential-byte checks still apply.
const REVIEWED_PRIVATE_NAME_SOURCE = new Set(['tests/sponsor-session-ui.test.mjs']);
const EXCLUDED = new Set(['.data', 'work', 'node_modules', 'dist', 'migration-prep', 'handover', 'deliverables', 'videos', '.git', '.vercel', '__pycache__', '.cache', '.pytest_cache', 'coverage']);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json', '.sql', '.py', '.md', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.mp4', '.srt', '.pdf', '.command', '.woff', '.woff2']);
const KIND = 'refund-office-offline-sponsor-application';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };
const validPath = path => typeof path === 'string' && path.length < 300 && !path.includes('\\') && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');

function noLinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('Symbolic links are not permitted in application package paths.');
    if (dirname(current) === current) break;
  }
}

function readRegular(root, path) {
  if (!validPath(path)) fail('Invalid application source path.');
  const absolute = resolve(root, path);
  noLinks(absolute);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('Application sources must be regular files no larger than 64 MiB.');
  return { bytes: readFileSync(absolute), mode: stat.mode & 0o777 };
}

function validateTemplate(bytes) {
  const safe = { REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_CHALLENGER: 'none',
    REFUND_OFFICE_HOSTED: 'disabled', REFUND_OFFICE_WORKING_STORE: 'sqlite', REFUND_OFFICE_PAYMENT_EXECUTION: 'disabled',
    DB_PATH: '.data/refund-office.sqlite', API_PORT: '4174', PORT_BLUEPRINT_ID: 'refund-office-service' };
  const seen = new Set();
  for (const raw of bytes.toString('utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || seen.has(match[1])) fail('Environment templates require unique plain assignments.');
    seen.add(match[1]);
    if (match[2] && match[2] !== safe[match[1]]) fail('A filled or unsafe environment template cannot be packaged.');
  }
  if (!seen.has('REFUND_OFFICE_NETWORK') || !/^REFUND_OFFICE_NETWORK=offline$/m.test(bytes.toString('utf8'))) fail('Environment templates must retain offline mode.');
}

function validateSource(path, bytes) {
  const name = basename(path);
  if (TEMPLATES.has(path)) validateTemplate(bytes);
  else if ((!REVIEWED_PRIVATE_NAME_SOURCE.has(path) && /(?:^|[./_-])(?:credentials?|secrets?|tokens?|passwords?|cookies?|sessions?|private)(?:[./_-]|$)/i.test(path)) || /(?:^|\.)env(?:\.|$)/i.test(name) || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx|log|bak)$/i.test(name)) fail('Unexpected private file in an application source folder: ' + path);
  if (!TEMPLATES.has(path) && !['.gitignore', '.npmrc'].includes(name) && !EXTENSIONS.has(extname(path))) fail('Unsupported application source file: ' + path);
  if (path.startsWith('.openai/') && path !== '.openai/hosting.json') fail('Unexpected hosting configuration file.');
  if (path === '.npmrc' && bytes.toString('utf8').trim() !== 'fund=false\naudit=false') fail('Only the credential-free npm defaults may be packaged.');
  if (!['.png', '.jpg', '.jpeg', '.webp', '.ico', '.mp4', '.pdf', '.woff', '.woff2'].includes(extname(path))) {
    const text = bytes.toString('utf8');
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk_(?:live|test)_|rk_(?:live|test)_|sk-proj-|sb_secret_|ghp_|github_pat_)[A-Za-z0-9_-]{24,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/.test(text)) fail('Credential-like material found in application source: ' + path);
  }
  if (path.startsWith('launchers/')) {
    const text = bytes.toString('utf8');
    if (!path.endsWith('.command') || !text.includes('$(dirname -- "$0")/..') || /\/(?:Users|home)\//.test(text)) fail('Launchers must resolve the project relative to their own location.');
  }
}

export function collectApplicationSources(projectDir = ROOT) {
  projectDir = resolve(projectDir);
  noLinks(projectDir);
  const files = new Map();
  let total = 0;
  const add = path => {
    const source = readRegular(projectDir, path);
    validateSource(path, source.bytes);
    total += source.bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('The application source package exceeds 128 MiB.');
    files.set(path, source);
  };
  const walk = prefix => {
    noLinks(resolve(projectDir, prefix));
    for (const entry of readdirSync(resolve(projectDir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) fail('Symbolic links are not permitted in application sources: ' + path);
      if (path === 'docs/demo' || EXCLUDED.has(entry.name) || ['.DS_Store', 'Thumbs.db'].includes(entry.name) || /\.(?:pyc|pyo|tsbuildinfo)$/.test(entry.name)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path);
      else fail('Unsupported application source type: ' + path);
    }
  };
  for (const path of APPLICATION_ROOT_FILES) add(path);
  for (const path of APPLICATION_SOURCE_DIRECTORIES) walk(path);
  const doc = files.get(VERIFICATION_DOCUMENT)?.bytes.toString('utf8') || '';
  const firstParagraph = doc.replace(/^\s*#[^\n]*\n/, '').trim().split(/\r?\n\s*\r?\n/)[0];
  if (firstParagraph !== FINAL_STATUS) fail('The sponsor verification document must contain the final passed status as its first paragraph.');
  const pkg = JSON.parse(files.get('package.json').bytes), lock = JSON.parse(files.get('package-lock.json').bytes);
  if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name || JSON.stringify(lock.packages?.['']?.dependencies || {}) !== JSON.stringify(pkg.dependencies || {})) fail('The dependency lock does not match the packaged application.');
  return files;
}

function checkedEvidence(projectDir, absolute, prefix) {
  const path = relative(projectDir, resolve(absolute));
  if (!path.startsWith(prefix + '/') || !validPath(path)) fail('The database verification points outside its owned evidence directory.');
  return JSON.parse(readRegular(projectDir, path).bytes);
}

function databaseSummary(projectDir, files) {
  const prefix = 'work/sponsor-wiring/database';
  const latest = JSON.parse(readRegular(projectDir, prefix + '/latest.json').bytes);
  const combined = checkedEvidence(projectDir, latest.evidence, prefix + '/runs');
  const runDirectory = relative(projectDir, dirname(resolve(latest.evidence)));
  const verification = checkedEvidence(projectDir, combined.evidence?.verification, runDirectory);
  const before = checkedEvidence(projectDir, combined.evidence?.sourcesBefore, runDirectory);
  const after = checkedEvidence(projectDir, combined.evidence?.sourcesAfter, runDirectory);
  if (latest.passed !== true || combined.passed !== true || combined.sourceUnchanged !== true || verification.passed !== true || combined.fatal !== null || verification.fatal !== null || before.digest !== after.digest || combined.sourceDigest !== before.digest || sha256(JSON.stringify(before.files)) !== before.digest || JSON.stringify(before.files) !== JSON.stringify(after.files)) fail('A complete, unchanged, passed combined database verification is required.');
  if (!Array.isArray(before.files) || before.files.length !== combined.sourceFiles || before.files.some(file => !files.has(file.path) || files.get(file.path).bytes.length !== file.bytes || sha256(files.get(file.path).bytes) !== file.sha256)) fail('The combined database verification is stale for the current packaged source.');
  const expectedChecks = { total: 41, passed: 41, failed: 0, base: 20, workflow: 7, payment: 8, hosted: 6 };
  if (Object.entries(expectedChecks).some(([key, value]) => combined.checks?.[key] !== value) || verification.checks?.length !== expectedChecks.total || verification.checks.some(check => check.passed !== true)) fail('The combined database check counts are incomplete.');
  for (const record of [combined.database, verification.database]) if (record?.network !== 'none' || record.localUnixSocket !== true || record.existingDataMounts !== false || record.cleanedUp !== true) fail('The database evidence must confirm isolation and completed cleanup.');
  const migrationHashes = Object.fromEntries([...files].filter(([path]) => /^integrations\/supabase\/runtime\/\d.*\.sql$/.test(path)).map(([path, file]) => [path, sha256(file.bytes)]));
  if (Object.keys(migrationHashes).length !== 5 || Object.entries(migrationHashes).some(([path, hash]) => combined.migrationHashes?.[path] !== hash)) fail('Migration hashes do not match the combined database verification.');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(combined.completedAt) || !Number.isSafeInteger(combined.sqlRoundTrips) || !Number.isSafeInteger(combined.expectedRejections)) fail('Invalid database verification metadata.');
  return { schemaVersion: 1, kind: 'local-combined-database-verification-summary', passed: true, completedAt: combined.completedAt,
    scope: 'Disposable local PostgreSQL only. Synthetic identities and injected provider fixtures; no cloud account, verified JWT, external API or live payment acceptance.',
    checks: expectedChecks, sqlRoundTrips: combined.sqlRoundTrips, expectedRejections: combined.expectedRejections,
    isolation: { network: 'none', localUnixSocket: true, existingDataMounts: false, cleanedUp: true },
    sourceDigest: before.digest, sourceFiles: before.files, migrationHashes };
}

const ZIP_PROGRAM = `import hashlib,json,os,stat,sys,zipfile
mode,archive,stage=sys.argv[1:]
manifest=json.load(sys.stdin)
expected={entry['path']:entry for entry in manifest['files']}
manifest_bytes=(json.dumps(manifest,indent=2,ensure_ascii=False)+'\\n').encode()
if mode=='write':
 with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
  for path,entry in sorted(expected.items()):
   data=open(os.path.join(stage,path),'rb').read()
   info=zipfile.ZipInfo(path,date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=(stat.S_IFREG|entry['mode'])<<16
   z.writestr(info,data)
  info=zipfile.ZipInfo('application-manifest.json',date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=(stat.S_IFREG|0o644)<<16
  z.writestr(info,manifest_bytes)
with zipfile.ZipFile(archive,'r') as z:
 names=z.namelist();assert sorted(names)==sorted(list(expected)+['application-manifest.json']) and len(names)==len(set(names)), 'Archive inventory differs'
 assert z.testzip() is None, 'Archive CRC failed'
 assert z.read('application-manifest.json')==manifest_bytes, 'Archive manifest differs'
 for path,entry in expected.items():
  info=z.getinfo(path);data=z.read(path)
  assert stat.S_ISREG(info.external_attr>>16) and (info.external_attr>>16)&0o777==entry['mode'], 'Archive file mode differs'
  assert len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'], 'Archive content differs'
print(json.dumps({'verified':True,'files':len(names)}))
`;

export function verifySponsorApplicationArchive({ archivePath, manifest, stage = '', write = false }) {
  const result = spawnSync('python3', ['-B', '-c', ZIP_PROGRAM, write ? 'write' : 'verify', archivePath, stage], {
    input: json(manifest), encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error || result.status !== 0) fail('Archive creation/readback failed: ' + (result.error?.message || result.stderr.trim().slice(-1200)));
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.verified, true);
  return verified;
}

export function prepareSponsorApplication({ projectDir = ROOT, outputDir = join(projectDir, 'deliverables') } = {}) {
  projectDir = resolve(projectDir); outputDir = resolve(outputDir);
  noLinks(outputDir);
  const outputRelative = relative(projectDir, outputDir);
  if (!outputRelative || outputRelative === '..' || projectDir.startsWith(outputDir + sep) || APPLICATION_SOURCE_DIRECTORIES.some(path => outputRelative === path || outputRelative.startsWith(path + sep))) fail('Package output must be separate from application sources.');
  const files = collectApplicationSources(projectDir);
  files.set('verification/sponsor-database-summary.json', { bytes: Buffer.from(json(databaseSummary(projectDir, files))), mode: 0o644 });
  files.set('PACK-CONTENTS.md', { bytes: Buffer.from('# Refund Office sponsor application source package\n\nThis package contains the full application source, both synthetic case catalogues, the existing dependency lock, relative launchers, integration preparation files, current setup guides, the sponsor verification note and architecture maps. Blank environment templates retain safe offline defaults.\n\nDependencies and `node_modules`, generated builds, private databases, raw work evidence, old deliverable archives and historical videos are excluded. The older `docs/demo` video and captions are also omitted. The current README and guides retain historical links to some of these intentionally omitted local artifacts; those links do not imply that the artifacts are in this package. Source documents have not been rewritten to hide their history.\n\n`application-manifest.json` records every included source file and generated summary with its SHA-256 hash and file mode. The ZIP was reopened and its complete inventory and bytes checked against that manifest. The manifest itself is the one additional ZIP entry.\n\n`verification/sponsor-database-summary.json` contains a sanitised summary of the current passed disposable PostgreSQL check, including the exact checked source hashes. It contains no local paths, session data, container identifiers or raw execution records. Those tests used synthetic identities and injected provider fixtures. Sponsor accounts remain disconnected; provider account acceptance, real Supabase authentication and external payment execution are unverified.\n\nDependencies must be installed from the included lockfile before using the source. Follow `README.md` and `docs/HOSTED-SETUP.md`; the prepared hosted source is not a deployed or connected service.\n'), mode: 0o644 });
  const generated = new Set(['PACK-CONTENTS.md', 'verification/sponsor-database-summary.json']);
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, bytes: file.bytes.length, mode: file.mode, sha256: sha256(file.bytes), source: generated.has(path) ? 'generated-package-metadata' : path }));
  const manifest = { schemaVersion: 1, kind: KIND, preparedAt: new Date().toISOString(), mode: 'offline', standaloneApplicationSource: true,
    dependenciesIncluded: false, databasesIncluded: false, sponsorAccountsConnected: false, deploymentPerformed: false,
    verificationDocument: VERIFICATION_DOCUMENT, databaseVerification: 'verification/sponsor-database-summary.json',
    exclusions: [...EXCLUDED, 'docs/demo'].sort(), sourceDigest: sha256(JSON.stringify(entries)), files: entries, totalContentBytes: entries.reduce((total, file) => total + file.bytes, 0) };
  const archivePath = join(outputDir, APPLICATION_ARCHIVE_NAME), manifestPath = archivePath.replace(/\.zip$/, '.manifest.json'), checksumPath = archivePath.replace(/\.zip$/, '.sha256');
  for (const path of [archivePath, manifestPath, checksumPath]) if (existsSync(path)) fail('Refusing to overwrite an existing application package: ' + basename(path));
  mkdirSync(outputDir, { recursive: true });
  const stage = mkdtempSync(join(outputDir, '.sponsor-application-'));
  const published = [];
  try {
    for (const [path, file] of files) { mkdirSync(dirname(join(stage, path)), { recursive: true }); writeFileSync(join(stage, path), file.bytes); }
    const stagedZip = join(stage, APPLICATION_ARCHIVE_NAME);
    const verified = verifySponsorApplicationArchive({ archivePath: stagedZip, manifest, stage, write: true });
    const current = collectApplicationSources(projectDir);
    if (current.size !== files.size - generated.size || [...current].some(([path, file]) => !files.has(path) || file.mode !== files.get(path).mode || !file.bytes.equals(files.get(path).bytes))) fail('Application sources changed during packaging; repeat from a stable source tree.');
    const digest = sha256(readFileSync(stagedZip));
    const stagedManifest = join(stage, 'manifest-sidecar.json'), stagedChecksum = join(stage, 'checksum-sidecar.txt');
    writeFileSync(stagedManifest, json(manifest));
    writeFileSync(stagedChecksum, digest + '  ' + APPLICATION_ARCHIVE_NAME + '\n');
    for (const [source, destination] of [[stagedZip, archivePath], [stagedManifest, manifestPath], [stagedChecksum, checksumPath]]) { linkSync(source, destination); published.push(destination); }
    verifySponsorApplicationArchive({ archivePath, manifest });
    if (sha256(readFileSync(archivePath)) !== digest) fail('Published archive hash differs from verified content.');
    return { archivePath, manifestPath, checksumPath, sha256: digest, archiveFiles: verified.files, manifest };
  } catch (error) {
    for (const path of published) rmSync(path);
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('Run without arguments to prepare the new sponsor application archive.');
    const result = prepareSponsorApplication();
    console.log(JSON.stringify({ archivePath: result.archivePath, sha256: result.sha256, archiveFiles: result.archiveFiles, verified: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
