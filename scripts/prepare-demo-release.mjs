import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySponsorApplicationArchive } from './prepare-sponsor-application.mjs';
import { renderRuntimeScorecards } from './evaluate-runtime.mjs';
import { prepareRuntimeEvaluationRows } from '../server/runtime-evaluation-scorecard.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RELEASE_SOURCE_DIRECTORIES = Object.freeze(['src', 'server', 'api', 'scripts', 'tests', 'integrations', 'demo-data', 'public', 'worker', '.openai', 'docs', 'launchers']);
export const RELEASE_ROOT_FILES = Object.freeze(['package.json', 'package-lock.json', 'vite.config.mjs', 'vite.runtime.config.mjs', 'vite.evidence.config.mjs', 'index.html', 'README.md', 'ARCHITECTURE.md', 'AGENTS.md', 'design-qa.md', '.env.example', '.npmrc', '.gitignore']);
export const RELEASE_EVIDENCE = Object.freeze({ runtime: 'work/runtime-evaluations/run-e9f2Ea', model: 'work/model-investigation/2026-10-14T20-32-21-210Z-41b25956' });
const TEMPLATE_PATHS = new Set(['.env.example', 'integrations/.env.example', 'integrations/vercel/hosted.env.example', 'integrations/arize/.env.example']);
const EXCLUDED = new Set(['.data', 'work', 'node_modules', 'dist', 'migration-prep', 'handover', 'deliverables', 'videos', '.git', '.vercel', '__pycache__', '.cache', '.pytest_cache', 'coverage']);
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json', '.sql', '.py', '.md', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.srt', '.pdf', '.command', '.woff', '.woff2']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.pdf', '.woff', '.woff2']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };
const validPath = value => typeof value === 'string' && value.length < 400 && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

function noLinks(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('Release paths must not contain symbolic links.');
    if (dirname(current) === current) break;
  }
}
function readRegular(projectDir, path) {
  if (!validPath(path)) fail('Invalid release source path.');
  const absolute = resolve(projectDir, path); noLinks(absolute);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail('Release files must be regular files no larger than 64 MiB.');
  return { bytes: readFileSync(absolute), mode: stat.mode & 0o777, source: path };
}
function checkText(path, bytes) {
  if (BINARY.has(extname(path))) return;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk_(?:live|test)_|rk_(?:live|test)_|sk-proj-|sk-ant-|sb_secret_|ghp_|github_pat_)[A-Za-z0-9_-]{24,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/.test(text)) fail('Credential-like material found in release source: ' + path);
}
function checkTemplate(path, bytes) {
  const safe = { REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_CHALLENGER: 'none', REFUND_OFFICE_HOSTED: 'disabled', REFUND_OFFICE_HOSTED_TRACING: 'disabled', REFUND_OFFICE_WORKING_STORE: 'sqlite', REFUND_OFFICE_PAYMENT_EXECUTION: 'disabled', DB_PATH: '.data/refund-office.sqlite', API_PORT: '4174', PORT_BLUEPRINT_ID: 'refund-office-service', ARIZE_NETWORK_ENABLED: 'false', ARIZE_TRACE_UPLOAD_ENABLED: 'false', ARIZE_PROJECT_NAME: 'refund-office-synthetic' };
  const assignments = new Map();
  for (const raw of bytes.toString('utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || assignments.has(match[1]) || match[2] && match[2] !== safe[match[1]]) fail('Release templates must have blank credentials and safe offline defaults: ' + path);
    assignments.set(match[1], match[2]);
  }
  if (path === 'integrations/arize/.env.example') {
    if (assignments.get('ARIZE_NETWORK_ENABLED') !== 'false' || assignments.get('ARIZE_TRACE_UPLOAD_ENABLED') !== 'false') fail('Arize uploads must remain disabled.');
  } else if (assignments.get('REFUND_OFFICE_NETWORK') !== 'offline') fail('Release templates must retain offline mode.');
}
function validateSource(path, bytes) {
  const name = basename(path);
  if (TEMPLATE_PATHS.has(path)) checkTemplate(path, bytes);
  else if ((path !== 'tests/sponsor-session-ui.test.mjs' && /(?:^|[./_-])(?:credentials?|secrets?|tokens?|passwords?|cookies?|sessions?|private)(?:[./_-]|$)/i.test(path)) || /(?:^|\.)env(?:\.|$)/i.test(name) || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx|log|bak)$/i.test(name)) fail('Unexpected private file in release source: ' + path);
  if (!TEMPLATE_PATHS.has(path) && !['.gitignore', '.npmrc'].includes(name) && !EXTENSIONS.has(extname(path))) fail('Unsupported release source: ' + path);
  if (path.startsWith('.openai/') && path !== '.openai/hosting.json') fail('Unexpected hosting file.');
  if (path === '.npmrc' && bytes.toString('utf8').trim() !== 'fund=false\naudit=false') fail('The release cannot include npm credentials or custom network configuration.');
  if (path.startsWith('launchers/') && (!path.endsWith('.command') || !bytes.toString('utf8').includes('$(dirname -- "$0")/..') || /\/(?:Users|home)\//.test(bytes.toString('utf8')))) fail('Release launchers must resolve the project relative to their own location.');
  checkText(path, bytes);
}

export function collectDemoReleaseSources(projectDir = ROOT) {
  projectDir = resolve(projectDir); noLinks(projectDir);
  const files = new Map(); let total = 0;
  const add = path => { const file = readRegular(projectDir, path); validateSource(path, file.bytes); total += file.bytes.length; if (total > 160 * 1024 * 1024) fail('Release source exceeds 160 MiB.'); files.set(path, file); };
  const walk = prefix => {
    noLinks(resolve(projectDir, prefix));
    for (const entry of readdirSync(resolve(projectDir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) fail('Release source must not contain symbolic links: ' + path);
      if (path === 'docs/demo' || EXCLUDED.has(entry.name) || ['.DS_Store', 'Thumbs.db'].includes(entry.name) || /\.(?:pyc|pyo|tsbuildinfo)$/.test(entry.name)) continue;
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) add(path); else fail('Unsupported release source type: ' + path);
    }
  };
  for (const path of RELEASE_ROOT_FILES) add(path);
  for (const path of RELEASE_SOURCE_DIRECTORIES) walk(path);
  const pkg = JSON.parse(files.get('package.json').bytes), lock = JSON.parse(files.get('package-lock.json').bytes);
  if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name || JSON.stringify(lock.packages?.['']?.dependencies || {}) !== JSON.stringify(pkg.dependencies || {})) fail('The dependency lock differs from the application.');
  return files;
}

function readJSON(projectDir, path) { return JSON.parse(readRegular(projectDir, path).bytes); }
function verifiedSources(projectDir, prefix, files, expectedDigest) {
  const before = readJSON(projectDir, prefix + '/sources-before.json'), after = readJSON(projectDir, prefix + '/sources-after.json');
  if (!Array.isArray(before.files) || !before.files.length || JSON.stringify(before) !== JSON.stringify(after) || before.digest !== sha256(JSON.stringify(before.files)) || expectedDigest !== before.digest) fail('Recorded evidence lacks an unchanged source snapshot.');
  for (const entry of before.files) {
    const current = files.get(entry.path);
    if (!current || entry.bytes !== current.bytes.length || entry.sha256 !== sha256(current.bytes)) fail('Recorded evidence is stale for a packaged module: ' + entry.path);
  }
  return before;
}
function databaseSummary(projectDir, prefix, expectedCount) {
  const record = readJSON(projectDir, prefix + '/verification.json');
  if (record.passed !== true || record.fatal !== null || record.checks?.length !== expectedCount || record.checks.some(check => check.passed !== true)) fail('The recorded database check is incomplete.');
  const db = record.database;
  if (db?.network !== 'none' || db.localUnixSocket !== true || db.existingDataMounts !== false || db.cleanedUp !== true) fail('The recorded database check lacks completed local isolation.');
  return { passed: true, startedAt: record.startedAt, completedAt: record.completedAt, scope: record.scope, checkGroups: record.checks.length, checks: record.checks.map(check => ({ title: check.title, passed: check.passed })), isolation: { network: db.network, localUnixSocket: true, existingDataMounts: false, cleanedUp: true }, source: prefix + '/verification.json', rawExecutionDetailsIncluded: false };
}

export function collectDemoReleaseEvidence(projectDir, sources) {
  const files = new Map();
  const add = (path, value, source = 'generated-release-metadata') => files.set(path, { bytes: Buffer.from(json(value)), mode: 0o644, source });
  const runtime = readJSON(projectDir, RELEASE_EVIDENCE.runtime + '/manifest.json');
  if (runtime.passed !== true || runtime.synthetic !== true || runtime.uploaded !== false || runtime.sourceUnchanged !== true || runtime.cases !== 62 || runtime.checks !== 634 || runtime.spans !== 310 || runtime.externalRequests !== 0 || runtime.databaseChecks !== 22 || runtime.failure !== null) fail('The current runtime evaluation is incomplete.');
  const runtimeSources = verifiedSources(projectDir, RELEASE_EVIDENCE.runtime, sources, runtime.sourceDigest);
  const runtimeDB = databaseSummary(projectDir, RELEASE_EVIDENCE.runtime, 22);
  add('recorded-evidence/runtime/sources.json', runtimeSources, RELEASE_EVIDENCE.runtime + '/sources-before.json');
  add('recorded-evidence/runtime/database-summary.json', runtimeDB);
  add('recorded-evidence/runtime/manifest.json', { ...runtime, outputDir: 'recorded-evidence/runtime', source: RELEASE_EVIDENCE.runtime + '/manifest.json', copiedRecordedEvidence: true });
  for (const name of ['index.html', 'observed-cases.json', 'scorecards.json', 'traces.json', 'arize-evaluations.json']) {
    const source = readRegular(projectDir, RELEASE_EVIDENCE.runtime + '/' + name);
    checkText(name, source.bytes);
    if (/\/(?:Users|home)\//.test(source.bytes.toString('utf8'))) fail('Recorded runtime output contains a machine-specific path.');
    files.set('recorded-evidence/runtime/' + name, source);
  }
  const observed = JSON.parse(files.get('recorded-evidence/runtime/observed-cases.json').bytes);
  const traces = JSON.parse(files.get('recorded-evidence/runtime/traces.json').bytes);
  const scorecards = JSON.parse(files.get('recorded-evidence/runtime/scorecards.json').bytes);
  if (observed.length !== 62 || traces.synthetic !== true || traces.uploaded !== false || traces.spans?.length !== 310 || scorecards.length !== 2 || scorecards.some(card => card.synthetic !== true || card.uploaded !== false || card.passed !== true || card.summary?.failed !== 0 || ['approvals', 'newOperations', 'paymentExecutions', 'externalRequests'].some(name => card.counters?.[name] !== 0)) || scorecards.reduce((sum, card) => sum + card.summary.checks, 0) !== 634 || JSON.stringify(scorecards.flatMap(card => card.cases.map(record => ({ ...record, packId: card.dataset.id })))) !== JSON.stringify(observed)) fail('Recorded report data differs from its evaluation counts or offline boundaries.');
  const htmlPath = 'recorded-evidence/runtime/index.html', htmlSource = files.get(htmlPath);
  if (htmlSource.bytes.toString('utf8') !== renderRuntimeScorecards(scorecards, traces.spans) || JSON.stringify(JSON.parse(files.get('recorded-evidence/runtime/arize-evaluations.json').bytes)) !== JSON.stringify(prepareRuntimeEvaluationRows(scorecards, traces.spans))) fail('Recorded derived outputs differ from their scorecards and traces.');
  const portableHTML = htmlSource.bytes.toString('utf8').replace('<a href="verification.json">Disposable database verification</a>', '<a href="database-summary.json">Recorded database summary (raw execution details omitted)</a>');
  if (portableHTML === htmlSource.bytes.toString('utf8')) fail('The runtime report verification link could not be made portable.');
  files.set(htmlPath, { ...htmlSource, bytes: Buffer.from(portableHTML), sourceSha256: sha256(htmlSource.bytes), transformation: 'The database verification link points to its included sanitised summary and is labelled accordingly; recorded results unchanged.' });
  const model = readJSON(projectDir, RELEASE_EVIDENCE.model + '/model-verification.json');
  if (model.passed !== true || model.sourceUnchanged !== true || model.checks !== 26 || model.failure !== null) fail('The current model verification is incomplete.');
  const modelSources = verifiedSources(projectDir, RELEASE_EVIDENCE.model, sources, model.sourceDigest);
  add('recorded-evidence/model/sources.json', modelSources, RELEASE_EVIDENCE.model + '/sources-before.json');
  add('recorded-evidence/model/database-summary.json', databaseSummary(projectDir, RELEASE_EVIDENCE.model, 26));
  add('recorded-evidence/model/manifest.json', { ...model, databaseVerification: 'recorded-evidence/model/database-summary.json', source: RELEASE_EVIDENCE.model + '/model-verification.json', copiedRecordedEvidence: true });
  return files;
}

function artifactTarget(document, target, projectDir) {
  target = target.replace(/^<|>$/g, '').split('#')[0].split('?')[0];
  if (!target || /^(?:https?:|mailto:|data:|app:|codex:)/i.test(target)) return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  if (target.startsWith('/')) {
    const local = relative(projectDir, target);
    return validPath(local) ? local.split(sep).join('/') : 'outside-project/' + basename(target);
  }
  return posix.normalize(posix.join(posix.dirname(document), target));
}
function preparedTarget(path) {
  for (const [kind, prefix] of Object.entries(RELEASE_EVIDENCE)) {
    if (path === prefix + '/verification.json') return `recorded-evidence/${kind}/database-summary.json`;
    if (path === prefix + '/model-verification.json') return 'recorded-evidence/model/manifest.json';
    if (path.startsWith(prefix + '/')) return `recorded-evidence/${kind}/` + path.slice(prefix.length + 1);
  }
  return path;
}

// Source code is copied byte for byte. Markdown copies only redirect local links
// to included evidence or to an explicit catalogue entry for an omitted artifact.
export function preparePortableDocuments(files, projectDir) {
  const artifacts = new Map();
  for (const [path, file] of [...files]) {
    if (extname(path) !== '.md') continue;
    const original = file.bytes.toString('utf8');
    const text = original.replace(/(!?\[[^\]\n]*\])\((<[^>\n]+>|[^\s)]+)\)/g, (whole, label, target) => {
      const local = artifactTarget(path, target, projectDir); if (!local) return whole;
      const mapped = preparedTarget(local), available = files.has(mapped) || ['ARTIFACTS.md', 'recorded-evidence/artifact-status.json'].includes(mapped);
      if (available) {
        if (mapped === local && !target.startsWith('/') && !target.startsWith('</')) return whole;
        const fragment = target.replace(/^<|>$/g, '').match(/#[^?]*$/)?.[0] || '';
        const destination = posix.relative(posix.dirname(path), mapped) + fragment;
        return label + '(' + (destination.includes(' ') ? '<' + destination + '>' : destination) + ')';
      }
      const id = 'artifact-' + sha256(local).slice(0, 14);
      if (!artifacts.has(local)) artifacts.set(local, { id, target: local, status: 'not included', reason: local.startsWith('work/') ? 'Recorded working evidence is retained in the original project. Only the current selected evaluation and sanitised verification summaries travel with this release.' : local.includes('videos/') || local.startsWith('docs/demo') ? 'Historical video or recording retained separately; it is not included in this source package.' : local.startsWith('.data/') ? 'Private saved rehearsal data is deliberately excluded.' : 'This referenced artifact is outside the selected source and evidence inventory.' });
      return label.replace(/^!/, '') + '(' + posix.relative(posix.dirname(path), 'ARTIFACTS.md') + '#' + id + ')';
    });
    if (text !== original) files.set(path, { ...file, bytes: Buffer.from(text), sourceSha256: sha256(file.bytes), transformation: 'Local documentation links redirected to included recorded evidence or the omission catalogue; claims and source code unchanged.' });
  }
  const lines = ['# Release artifact catalogue', '', 'The manifest lists every file in this archive. The source documentation includes historical references. In this portable copy, links to omitted local artifacts lead here so they cannot be mistaken for included evidence.', '', '## Included entry points', '', '- [Current PostgreSQL evaluation](recorded-evidence/runtime/index.html)', '- [Recorded model checks](recorded-evidence/model/database-summary.json)', '- [Business comparison tool](docs/business-validation/study.html)', '- [Architecture map](docs/diagrams/local-observability.html)', '- [Release setup](docs/RELEASE-HANDOVER.md)', '', '## Omitted referenced artifacts', ''];
  for (const entry of [...artifacts.values()].sort((a, b) => a.target.localeCompare(b.target))) lines.push(`<a id="${entry.id}"></a>`, '', '`' + entry.target + '`', '', 'Status: ' + entry.status + '. ' + entry.reason, '');
  files.set('ARTIFACTS.md', { bytes: Buffer.from(lines.join('\n') + '\n'), mode: 0o644, source: 'generated-release-metadata' });
  files.set('recorded-evidence/artifact-status.json', { bytes: Buffer.from(json({ schemaVersion: 1, omitted: [...artifacts.values()] })), mode: 0o644, source: 'generated-release-metadata' });
}

function startHere(releaseId) {
  return '# Refund Office offline release\n\nRelease: `' + releaseId + '`.\n\nStart with [the handover guide](docs/RELEASE-HANDOVER.md). It explains installation, the separate synthetic rehearsal and the three-minute walkthrough.\n\nThe package contains the current application source, dependency lock, blank configuration templates, both synthetic catalogues, setup guides, architecture maps and selected recorded verification. Provider accounts remain disconnected. Every refund requires a human decision; the local PostgreSQL rehearsal does not submit payments.\n\n[Open the recorded 62-case evaluation](recorded-evidence/runtime/index.html). It contains 634 checks and 310 actual workflow spans from the named earlier local run. [The model check summary](recorded-evidence/model/database-summary.json) records 26 check groups using controlled OpenAI and Anthropic responses. Their base database checks overlap, so do not add the groups together as unique coverage. Neither record proves account acceptance.\n\n`application-manifest.json` records every included file, mode and SHA-256. The archive generator reopens the ZIP and checks its complete bytes and inventory. It does not install dependencies or launch the extracted application. Clean extraction, install, build and browser rehearsal results must be recorded separately against this archive hash. Their status is pending at packaging time.\n\nDependencies, Docker images, private databases, raw user histories and historical videos are excluded. A computer with cached dependencies and the cached PostgreSQL image can rehearse offline. A fresh machine without those prerequisites cannot install or start this demo offline. No package step downloads them automatically.\n\nSee [the artifact catalogue](ARTIFACTS.md) for explicit omissions. Source code is unchanged; selected Markdown links in the packaged copies lead to portable evidence or the catalogue. The report links to its included sanitised database summary. The manifest records each original document hash and link transformation. The original project files are preserved.\n';
}

export function prepareDemoRelease({ projectDir = ROOT, outputDir = join(projectDir, 'deliverables', 'releases'), releaseId = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  projectDir = resolve(projectDir); outputDir = resolve(outputDir); noLinks(outputDir);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[a-z0-9-]+)?$/.test(releaseId)) fail('Use a dated release identity.');
  const relativeOutput = relative(projectDir, outputDir);
  if (!relativeOutput || projectDir.startsWith(outputDir + sep) || RELEASE_SOURCE_DIRECTORIES.some(path => relativeOutput === path || relativeOutput.startsWith(path + sep))) fail('Release output must be separate from source directories.');
  const destination = join(outputDir, releaseId);
  if (existsSync(destination)) fail('Refusing to overwrite an existing release.');
  const sources = collectDemoReleaseSources(projectDir), evidence = collectDemoReleaseEvidence(projectDir, sources), files = new Map([...sources, ...evidence]);
  files.set('START-HERE.md', { bytes: Buffer.from(startHere(releaseId)), mode: 0o644, source: 'generated-release-metadata' });
  preparePortableDocuments(files, projectDir);
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, bytes: file.bytes.length, mode: file.mode, sha256: sha256(file.bytes), source: file.source, ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256, transformation: file.transformation } : {}) }));
  const manifest = { schemaVersion: 1, kind: 'refund-office-offline-demo-release', releaseId, preparedAt: new Date().toISOString(), mode: 'offline', sourceDigest: sha256(JSON.stringify(entries)), dependenciesIncluded: false, databasesIncluded: false, sponsorAccountsConnected: false, deploymentPerformed: false, cleanExtractionCheck: { status: 'pending-separate-verification', scope: 'The packager verifies archive bytes only. Record extraction, installation, build and browser results separately against the ZIP SHA-256.' }, recordedEvidence: { runtime: { cases: 62, checks: 634, spans: 310, databaseCheckGroups: 22, sourceDigest: JSON.parse(evidence.get('recorded-evidence/runtime/manifest.json').bytes).sourceDigest }, model: { checkGroups: 26, sourceDigest: JSON.parse(evidence.get('recorded-evidence/model/manifest.json').bytes).sourceDigest }, liveProvidersTested: false, approvalsInEvaluationTenants: 0, paymentExecutionsInEvaluationTenants: 0 }, exclusions: [...EXCLUDED, 'docs/demo'].sort(), files: entries, totalContentBytes: entries.reduce((sum, file) => sum + file.bytes, 0) };
  mkdirSync(outputDir, { recursive: true });
  const stage = mkdtempSync(join(outputDir, '.release-stage-'));
  try {
    const sourceStage = join(stage, 'source');
    for (const [path, file] of files) { mkdirSync(dirname(join(sourceStage, path)), { recursive: true }); writeFileSync(join(sourceStage, path), file.bytes, { mode: file.mode }); }
    const archiveName = 'refund-office-offline-' + releaseId + '.zip', archivePath = join(stage, archiveName);
    const verified = verifySponsorApplicationArchive({ archivePath, manifest, stage: sourceStage, write: true });
    const current = collectDemoReleaseSources(projectDir), currentEvidence = collectDemoReleaseEvidence(projectDir, current);
    for (const [original, fresh] of [[sources, current], [evidence, currentEvidence]]) if (original.size !== fresh.size || [...original].some(([path, file]) => !fresh.has(path) || file.mode !== fresh.get(path).mode || !file.bytes.equals(fresh.get(path).bytes))) fail('Release sources changed during packaging; retry after edits finish.');
    const digest = sha256(readFileSync(archivePath));
    writeFileSync(join(stage, 'application-manifest.json'), json(manifest));
    writeFileSync(join(stage, archiveName + '.sha256'), digest + '  ' + archiveName + '\n');
    writeFileSync(join(stage, 'archive-verification.json'), json({ verified: true, releaseId, sha256: digest, archiveFiles: verified.files, completeReadback: true, cleanExtractionCheck: 'pending-separate-verification', externalRequests: 0 }));
    rmSync(sourceStage, { recursive: true });
    renameSync(stage, destination);
    const publishedArchive = join(destination, archiveName);
    verifySponsorApplicationArchive({ archivePath: publishedArchive, manifest });
    if (sha256(readFileSync(publishedArchive)) !== digest) fail('Published release differs from its verified archive.');
    return { directory: destination, archivePath: publishedArchive, manifestPath: join(destination, 'application-manifest.json'), checksumPath: join(destination, archiveName + '.sha256'), sha256: digest, archiveFiles: verified.files, manifest };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('Run without arguments to prepare a new dated offline release.');
    const result = prepareDemoRelease();
    console.log(json({ archivePath: result.archivePath, manifestPath: result.manifestPath, checksumPath: result.checksumPath, sha256: result.sha256, archiveFiles: result.archiveFiles, verified: true, cleanExtractionCheck: 'pending-separate-verification' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
