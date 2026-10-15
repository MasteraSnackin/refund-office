import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareSyntheticImport, canonicalJSON, contentHash } from '../server/supabase-import.mjs';
import { createLocalPostgresRuntime, sqlLiteral } from '../server/local-postgres-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'postgres:16-alpine';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PURPOSE = 'offline-runtime-rehearsal';
const PROJECT = contentHash(ROOT).slice(0, 16);
export const RUNTIME_PORTS = Object.freeze({ ui: 4273, api: 4274 });
export const RUNTIME_SCHEMAS = Object.freeze(['tests/supabase-runtime/bootstrap.sql', 'integrations/supabase/runtime/001_runtime.sql', 'integrations/supabase/runtime/002_office_workflow.sql']);
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const fail = message => { throw new Error(message); };

export function runtimeRehearsalEnvironment(source = process.env) {
  const safe = Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR','TERM','COLORTERM'].filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
  return { ...safe, REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_ENABLED_INTEGRATIONS: '',
    REFUND_OFFICE_WORKING_STORE: 'local-postgres-rehearsal', API_PORT: String(RUNTIME_PORTS.api), VITE_RUNTIME_REHEARSAL: '1' };
}
export async function runtimePortInUse(port) {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let finished = false;
    const done = result => { if (finished) return; finished = true; socket.destroy(); resolvePromise(result); };
    socket.setTimeout(500); socket.once('connect', () => done(true)); socket.once('timeout', () => done(true));
    socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
  });
}
export async function requireRuntimePortsFree(check = runtimePortInUse) {
  if ((await Promise.all(Object.values(RUNTIME_PORTS).map(check))).some(Boolean)) fail('The separate rehearsal ports are already in use. No process was stopped and no data was created.');
}
function safePath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('Rehearsal paths cannot contain symbolic links.');
    if (dirname(current) === current) break;
  }
}
function saveMarker(path, marker) {
  const next = { ...marker }; delete next.markerSha256;
  const encoded = JSON.stringify({ ...next, markerSha256: contentHash(next) }, null, 2) + '\n';
  const temp = path + '.tmp'; writeFileSync(temp, encoded, { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
}
export function expectedVolumeLabels(marker) {
  return { 'io.refund-office.purpose': PURPOSE, 'io.refund-office.project': PROJECT,
    'io.refund-office.rehearsal': marker.id, 'io.refund-office.dataset': marker.datasetId, 'io.refund-office.digest': marker.datasetDigest };
}
export function validateRuntimeMarker(marker, { id, pack, schemaHashes, members }) {
  if (!marker || typeof marker !== 'object') fail('The rehearsal marker is invalid.');
  const { markerSha256, ...payload } = marker;
  if (!UUID.test(id || '') || marker.id !== id || marker.kind !== 'refund-office-local-postgres-rehearsal' || marker.schemaVersion !== 1 || marker.status !== 'ready' || markerSha256 !== contentHash(payload)) fail('The rehearsal marker is incomplete or changed. Its saved data was not reset.');
  if (marker.datasetId !== pack.datasetId || marker.datasetDigest !== pack.manifest.digest || marker.tenantId !== pack.tenantId || marker.volumeName !== `refund-office-runtime-${id}` || canonicalJSON(marker.schemaHashes) !== canonicalJSON(schemaHashes) || canonicalJSON(marker.members) !== canonicalJSON(members) || !/^sha256:[a-f0-9]{64}$/.test(marker.imageId || '')) fail('The saved rehearsal does not match the current dataset, schema or local profiles. Start a separate new rehearsal; this one was not changed.');
  if (!marker.checkpoint?.sha256 || !/^[a-f0-9]{64}$/.test(marker.checkpoint.sha256)) fail('The saved rehearsal has no verified checkpoint. It cannot be resumed automatically.');
  return marker;
}
export function validateOwnedVolume(volume, marker) {
  if (!volume || volume.Name !== marker.volumeName || volume.Driver !== 'local' || volume.Scope !== 'local' || Object.keys(volume.Options || {}).length || Object.entries(expectedVolumeLabels(marker)).some(([key, value]) => volume.Labels?.[key] !== value)) fail('The Docker volume does not match this rehearsal. No existing volume was mounted or changed.');
}
function localDockerEndpoint() {
  for (const path of [join(homedir(), '.docker/run/docker.sock'), '/var/run/docker.sock']) {
    try { if (statSync(path).isSocket()) return 'unix://' + path; } catch { /* Try the other known local socket. */ }
  }
  fail('A running local Docker Unix socket and the cached PostgreSQL image are required. Remote Docker endpoints are not permitted.');
}

function dockerRunner(endpoint, configDirectory) {
  return async (args, { input = '', allowFailure = false, timeoutMs = 30000 } = {}) => {
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn('docker', ['--host',endpoint,'--config',configDirectory,...args], { cwd: ROOT,
        env: runtimeRehearsalEnvironment(), stdio: ['pipe','pipe','pipe'] });
      let stdout = '', stderr = '', oversized = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', bytes => { stdout += bytes; if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { oversized = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', bytes => { stderr += bytes; if (Buffer.byteLength(stderr) > 65536) { oversized = true; child.kill('SIGKILL'); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, oversized, timedOut }); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    if ((result.code !== 0 || result.timedOut || result.oversized) && !allowFailure) {
      const error = new Error(`The owned local Docker ${args[0]} action did not complete. Saved rehearsal data was retained.`);
      error.sqlState = result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
      throw error;
    }
    return result;
  };
}
export function authenticatedStatement({ statement, role, userId }) {
  if (role !== 'authenticated' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId || '') || !/^SELECT public\.refund_runtime_(read_workspace|read_case|enqueue_intake|claim_intake|finish_intake|approve_and_reserve|review_case|recover_intake|fail_intake)\(/.test(statement || '') || !statement.endsWith(');')) fail('Only an allowlisted local workflow call and local profile are permitted.');
  return `BEGIN;\nSET LOCAL standard_conforming_strings=on;\nSET LOCAL ROLE authenticated;\nSET LOCAL request.jwt.claim.sub=${sqlLiteral(userId)};\nSET LOCAL request.jwt.claims=${sqlLiteral(JSON.stringify({ sub: userId, role: 'authenticated', is_anonymous: false }))};\n${statement}\nCOMMIT;\n`;
}
export function parseRuntimeSqlResult(output, { statement } = {}) {
  // psql renders SQL NULL as a blank line. Only an empty claim queue is
  // allowed to produce that result; blank write acknowledgements still fail.
  if (!String(output).trim() && /^SELECT public\.refund_runtime_claim_intake\(/.test(statement || '')) return null;
  return JSON.parse(output);
}

export async function runRuntimeRehearsal({ packId, reuseId, baseDirectory = resolve(ROOT, '.data/runtime-rehearsals'), installSignalHandlers = true } = {}) {
  if (!['focused-12','busy-50'].includes(packId) || reuseId && !UUID.test(reuseId)) fail('Choose focused-12 or busy-50, with an optional explicit rehearsal UUID to reuse.');
  await requireRuntimePortsFree();
  const pack = prepareSyntheticImport(JSON.parse(readFileSync(resolve(ROOT, `demo-data/${packId}.json`), 'utf8')));
  const schemaHashes = Object.fromEntries(RUNTIME_SCHEMAS.map(path => [path, contentHash(readFileSync(resolve(ROOT, path)))]));
  const [{ LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER, createRuntimeSessions }, { createRuntimeService }, { createRuntimeApiServer }] = await Promise.all([
    import('../server/runtime-auth.mjs'), import('../server/runtime-service.mjs'), import('../server/runtime-api.mjs'),
  ]);
  const members = [...LOCAL_RUNTIME_PROFILES, LOCAL_RUNTIME_WORKER].map(profile => ({ userId: profile.userId, role: profile.role })).sort((a,b) => a.userId.localeCompare(b.userId));
  const id = reuseId || randomUUID();
  const directory = resolve(baseDirectory, id); safePath(directory);
  const markerPath = join(directory, 'rehearsal.json');
  let marker;
  if (reuseId) {
    if (!existsSync(markerPath)) fail('That explicitly selected rehearsal marker does not exist. No new database was created.');
    marker = validateRuntimeMarker(JSON.parse(readFileSync(markerPath, 'utf8')), { id, pack, schemaHashes, members });
  } else {
    if (existsSync(directory)) fail('The new rehearsal directory already exists. No existing data was changed.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const runId = randomUUID();
  const containerName = `refund-office-runtime-${id.slice(0,8)}-${runId.slice(0,8)}`;
  const lockPath = join(directory, 'active.json');
  if (existsSync(lockPath)) fail('This rehearsal has an active or interrupted owner marker. It was not opened twice or reset; inspect the previous owned run first.');
  writeFileSync(lockPath, JSON.stringify({ runId, pid: process.pid, containerName }), { flag: 'wx', mode: 0o600 });
  const configDirectory = mkdtempSync(join(tmpdir(), 'refund-runtime-docker-'));
  let docker, containerId, service, server, ui, sponsorLedger, stopping = false, started = false, lockOwned = true, containerAttempted = false;
  let resolveDone; const done = new Promise(resolvePromise => { resolveDone = resolvePromise; });
  async function adminSql(statement) {
    if (!containerId) fail('The owned rehearsal database is unavailable.');
    const result = await docker(['exec','-i',containerId,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'], { input: 'SET standard_conforming_strings=on;\n' + statement + '\n' });
    return result.stdout.trim();
  }
  async function checkpoint() {
    const tables = ['tenants','memberships','orders','order_lines','policies','cases','evidence','events','intake_requests','operations','approvals','commands'];
    // The list is a private-schema allowlist, never a supplied table name.
    const state = await adminSql('SELECT jsonb_build_object(' + tables.map(table => `${sqlLiteral(table)},(SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') FROM (SELECT to_jsonb(t) x FROM refund_runtime.${table} t) q)`).join(',') + ');');
    const parsed = JSON.parse(state);
    return { sha256: contentHash(parsed), counts: Object.fromEntries(Object.entries(parsed).map(([table, rows]) => [table, rows.length])) };
  }
  async function stop(code = 0) {
    if (stopping) return done; stopping = true;
    if (ui && ui.exitCode === null && ui.signalCode === null) {
      ui.kill('SIGTERM');
      await Promise.race([new Promise(resolvePromise => ui.once('exit',resolvePromise)),pause(2000)]);
      if (ui.exitCode === null && ui.signalCode === null) ui.kill('SIGKILL');
    }
    if (server) { server.closeIdleConnections?.(); server.closeAllConnections?.(); await new Promise(resolvePromise => server.close(() => resolvePromise())); }
    try { await service?.close(); } catch { code = 1; }
    try { sponsorLedger?.close(); } catch { code = 1; }
    if (started && containerId) {
      try { marker.checkpoint = await checkpoint(); marker.lastStoppedAt = new Date().toISOString(); saveMarker(markerPath, marker); }
      catch { code = 1; }
    }
    if (containerId) {
      try { await docker(['rm','--force',containerId]); }
      catch { code = 1; lockOwned = false; }
    }
    if (lockOwned && existsSync(lockPath)) {
      try { if (JSON.parse(readFileSync(lockPath, 'utf8')).runId === runId) rmSync(lockPath); } catch { code = 1; }
    }
    rmSync(configDirectory, { recursive: true, force: true });
    resolveDone(code); return code;
  }
  try {
    docker = dockerRunner(localDockerEndpoint(), configDirectory);
    const imageId = (await docker(['image','inspect',IMAGE,'--format','{{.Id}}'])).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail('The cached PostgreSQL image identity was not confirmed.');
    if (reuseId && marker.imageId !== imageId) fail('The cached PostgreSQL image differs from the saved rehearsal. The volume was not mounted.');
    if (!reuseId) {
      marker = { kind: 'refund-office-local-postgres-rehearsal', schemaVersion: 1, id, status: 'initializing',
        datasetId: packId, datasetDigest: pack.manifest.digest, tenantId: pack.tenantId, volumeName: `refund-office-runtime-${id}`,
        imageId, schemaHashes, members, createdAt: new Date().toISOString() };
      saveMarker(markerPath, marker);
      const prior = await docker(['volume','inspect',marker.volumeName], { allowFailure: true });
      if (prior.code === 0) fail('The new volume name already exists. It was not reused or reset.');
      await docker(['volume','create',...Object.entries(expectedVolumeLabels(marker)).flatMap(([key,value]) => ['--label',`${key}=${value}`]),marker.volumeName]);
    }
    validateOwnedVolume(JSON.parse((await docker(['volume','inspect',marker.volumeName])).stdout)[0], marker);
    containerAttempted = true;
    containerId = (await docker(['run','--detach','--pull=never','--network=none','--name',containerName,
      ...Object.entries({ ...expectedVolumeLabels(marker), 'io.refund-office.run': runId }).flatMap(([key,value]) => ['--label',`${key}=${value}`]),
      '--mount',`type=volume,source=${marker.volumeName},target=/var/lib/postgresql/data`, '--env','POSTGRES_HOST_AUTH_METHOD=trust',imageId])).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) fail('The new owned container identity was not confirmed.');
    const inspection = JSON.parse((await docker(['inspect',containerId])).stdout)[0];
    if (inspection.HostConfig.NetworkMode !== 'none' || Object.keys(inspection.HostConfig.PortBindings || {}).length || inspection.Mounts?.length !== 1 || inspection.Mounts[0].Type !== 'volume' || inspection.Mounts[0].Name !== marker.volumeName || inspection.Config.Labels?.['io.refund-office.run'] !== runId) fail('The owned container isolation checks failed.');
    const deadline = Date.now() + 25000;
    for (;;) {
      const main = await docker(['exec',containerId,'cat','/proc/1/comm'], { allowFailure: true });
      if (main.code === 0 && main.stdout.trim() === 'postgres' && (await docker(['exec',containerId,'pg_isready','-U','postgres'], { allowFailure: true })).code === 0) break;
      if (Date.now() > deadline) fail('The owned local database did not become ready. Its volume was retained.');
      await pause(100);
    }
    if (!reuseId) {
      for (const path of RUNTIME_SCHEMAS) await adminSql(readFileSync(resolve(ROOT,path),'utf8'));
      await adminSql('INSERT INTO auth.users(id) VALUES ' + members.map(member => `(${sqlLiteral(member.userId)}::uuid)`).join(',') + ';');
      await adminSql(`SELECT public.refund_runtime_import_dataset(${sqlLiteral(pack.tenantId)}::uuid,${sqlLiteral(canonicalJSON(pack.data))}::jsonb,${sqlLiteral(pack.manifest.digest)},${sqlLiteral(JSON.stringify(members))}::jsonb);`);
      marker.status = 'ready'; marker.checkpoint = await checkpoint(); saveMarker(markerPath, marker);
    } else {
      const catalogue = JSON.parse(await adminSql(`SELECT jsonb_build_object('id',id,'digest',dataset_digest,'synthetic',synthetic) FROM refund_runtime.tenants WHERE id=${sqlLiteral(marker.tenantId)}::uuid;`));
      if (catalogue.id !== marker.tenantId || catalogue.digest !== marker.datasetDigest || catalogue.synthetic !== true || (await checkpoint()).sha256 !== marker.checkpoint.sha256) fail('The saved database checkpoint or catalogue identity changed. It was not reset or used by the app.');
    }
    const executeSql = async input => parseRuntimeSqlResult(await adminSql(authenticatedStatement(input)), input);
    const auth = createRuntimeSessions({ tenantId: pack.tenantId, datasetTitle: pack.data.title });
    const repositoryForSession = principal => createLocalPostgresRuntime({ executeSql, tenantId: pack.tenantId, profile: principal });
    service = createRuntimeService({ repositoryForSession, workerRepository: repositoryForSession(auth.workerPrincipal()) });
    const [{ createSponsorActions }, { createSponsorActionLedger }, { createCaseAnalysis }] = await Promise.all([
      import('../server/sponsor-actions.mjs'), import('../server/sponsor-action-ledger.mjs'), import('../server/case-analysis.mjs'),
    ]);
    sponsorLedger = createSponsorActionLedger({ dbPath: join(directory, 'sponsor-actions.sqlite') });
    const offline = Object.freeze({});
    const sponsorActions = createSponsorActions({ env: offline, ledger: sponsorLedger, getPacket: service.exportCase, getBriefing: service.briefing, getBoard: service.boardExport });
    const analysis = createCaseAnalysis({ env: offline, getPacket: service.exportCase });
    server = createRuntimeApiServer({ service, auth, sponsorActions, analysis });
    await new Promise((resolvePromise, reject) => { server.once('error',reject); server.listen(RUNTIME_PORTS.api,'127.0.0.1',resolvePromise); });
    started = true; await service.start();
    ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--config','vite.runtime.config.mjs','--host','127.0.0.1','--port',String(RUNTIME_PORTS.ui),'--strictPort'], { cwd: ROOT, env: runtimeRehearsalEnvironment(), stdio: 'inherit' });
    ui.once('error', () => { void stop(1); }); ui.once('exit', code => { if (!stopping) void stop(code || 0); });
    if (installSignalHandlers) for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void stop(); });
    console.log(`Local PostgreSQL rehearsal: http://127.0.0.1:${RUNTIME_PORTS.ui}/ . All external services are off; payment submission is disabled.`);
    console.log(`Saved rehearsal ${id}. Resume explicitly with: node scripts/run-runtime-rehearsal.mjs ${packId} --reuse ${id}`);
    return { id, markerPath, volumeName: marker.volumeName, url: `http://127.0.0.1:${RUNTIME_PORTS.ui}/`, stop, done };
  } catch (error) {
    if (containerAttempted && !containerId && docker) {
      try {
        const result = await docker(['inspect',containerName], { allowFailure: true });
        if (result.code === 0) {
          const owned = JSON.parse(result.stdout)[0];
          if (owned.Config?.Labels?.['io.refund-office.run'] === runId && Object.entries(expectedVolumeLabels(marker)).every(([key,value]) => owned.Config.Labels[key] === value)) containerId = owned.Id;
          else lockOwned = false;
        }
      } catch { lockOwned = false; }
    }
    await stop(1); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packId, option, reuseId, ...extra] = process.argv.slice(2);
  if (extra.length || option && (option !== '--reuse' || !reuseId) || !option && reuseId) { console.error('Use a pack name, optionally followed by --reuse and its exact rehearsal UUID.'); process.exitCode = 1; }
  else runRuntimeRehearsal({ packId, reuseId }).then(async handle => { process.exitCode = await handle.done; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
