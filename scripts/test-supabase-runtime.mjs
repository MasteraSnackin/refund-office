import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { runSchemaChecks } from '../tests/supabase-runtime/checks.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = join(ROOT, 'work/supabase-runtime');
const IMAGE = 'postgres:16-alpine';
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function localDockerEndpoint() {
  // Never inherit DOCKER_HOST or a Docker context: this check may only reach a
  // known local Unix socket, even when the user's usual Docker target is remote.
  for (const path of [join(homedir(), '.docker/run/docker.sock'), '/var/run/docker.sock']) {
    try { if (statSync(path).isSocket()) return 'unix://' + path; } catch { /* Try the other local socket. */ }
  }
  throw new Error('A running local Docker Unix socket is required. Remote Docker endpoints are not permitted.');
}

export async function runSupabaseRuntimeChecks({ additionalChecks, outputDir = OUTPUT } = {}) {
  const evidenceDir = resolve(outputDir);
  if (!evidenceDir.startsWith(join(ROOT, 'work') + '/') || (additionalChecks !== undefined && typeof additionalChecks !== 'function')) throw new Error('Use a project work directory and an explicit local check function.');
  const dockerEndpoint = localDockerEndpoint();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const name = 'refund-office-sql-check-' + runId.slice(0, 12);
  const dockerConfig = mkdtempSync(join(tmpdir(), 'refund-office-docker-'));
  const checks = [], log = [];
  let containerId = null, imageId = null, fatal = null, cleanedUp = false, sqlRoundTrips = 0;
  const statementHashes = [], expectedFailures = [];
  mkdirSync(evidenceDir, { recursive: true });
  async function docker(args, { input = '', allowFailure = false, timeoutMs = 30000 } = {}) {
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn('docker', ['--host', dockerEndpoint, '--config', dockerConfig, ...args], {
        cwd: ROOT, env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C', TMPDIR: tmpdir() }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); resolvePromise({ code, stdout, stderr, timedOut }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    if (result.timedOut || result.code !== 0 && !allowFailure) throw new Error(`Local Docker command failed: ${args[0]} (${result.timedOut ? 'timeout' : result.code}). ${result.stderr.trim().slice(0, 1500)}`);
    return result;
  }
  async function sql(statement, { role, userId, anonymous = false, allowFailure = false } = {}) {
    if (role && !['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Unexpected test role.');
    const context = (role ? `set role ${role};\n` : '') + (userId ? `set request.jwt.claim.sub = ${quote(userId)};\nset request.jwt.claims = ${quote(JSON.stringify({ sub: userId, role: 'authenticated', is_anonymous: anonymous }))};\n` : '');
    sqlRoundTrips++;
    statementHashes.push(createHash('sha256').update(context + statement).digest('hex'));
    return docker(['exec', '-i', containerId, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { input: context + statement + '\n', allowFailure });
  }
  async function value(statement, options) {
    const result = await sql(statement, options);
    const line = result.stdout.trim().split('\n').at(-1);
    try { return JSON.parse(line); } catch { return line; }
  }
  async function rejected(statement, options = {}, pattern) {
    const result = await sql(statement, { ...options, allowFailure: true });
    assert.notEqual(result.code, 0, 'The forbidden database action unexpectedly succeeded.');
    if (pattern) assert.match(result.stderr, pattern);
    const rejection = { code: result.code, sqlState: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] || null,
      error: result.stderr.trim().split('\n').slice(0, 3).join(' ') };
    expectedFailures.push(rejection);
    return rejection;
  }
  async function check(title, action) {
    const start = Date.now();
    try {
      const detail = await action();
      checks.push({ title, passed: true, elapsedMs: Date.now() - start, ...(detail === undefined ? {} : { detail }) });
      log.push('PASS ' + title); console.log('PASS ' + title);
    } catch (error) {
      checks.push({ title, passed: false, elapsedMs: Date.now() - start, error: error.message });
      log.push('FAIL ' + title + ': ' + error.message); console.error('FAIL ' + title + ': ' + error.message);
      throw error;
    }
  }
  try {
    imageId = (await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}'])).stdout.trim();
    containerId = (await docker(['run', '--detach', '--pull=never', '--network=none', '--name', name,
      '--label', 'io.refund-office.purpose=offline-runtime-verification', '--label', 'io.refund-office.run=' + runId,
      '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE])).stdout.trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    const readinessDeadline = Date.now() + 20000;
    for (;;) {
      // The image briefly starts a temporary bootstrap server, then replaces
      // its entrypoint with the final postgres process. Wait for that handoff.
      const main = await docker(['exec', containerId, 'cat', '/proc/1/comm'], { allowFailure: true });
      if (main.code === 0 && main.stdout.trim() === 'postgres') {
        const result = await docker(['exec', containerId, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
        if (result.code === 0) break;
      }
      if (Date.now() >= readinessDeadline) throw new Error('The isolated PostgreSQL server did not become ready.');
      await delay(100);
    }
    await check('isolated cached PostgreSQL starts with no network, exposed ports or existing data mounts', async () => {
      const inspection = JSON.parse((await docker(['inspect', containerId])).stdout)[0];
      assert.equal(inspection.HostConfig.NetworkMode, 'none');
      assert.equal(Object.keys(inspection.HostConfig.PortBindings || {}).length, 0);
      assert.equal((inspection.Mounts || []).some(mount => mount.Type === 'bind' || mount.Type === 'volume'), false);
      const version = await value("select to_json(current_setting('server_version')); ");
      assert.match(version, /^16\./);
      return { serverVersion: version, network: 'none', publishedPorts: 0, existingDataMounts: 0 };
    });
    await sql(readFileSync(join(ROOT, 'tests/supabase-runtime/bootstrap.sql'), 'utf8'));
    await runSchemaChecks({ ROOT, sql, value, rejected, check, quote });
    if (additionalChecks) await additionalChecks({ ROOT, sql, value, rejected, check, quote });
  } catch (error) {
    fatal = error.message;
  } finally {
    // Recover an uncertain docker-run response only when the exact unique run
    // label confirms ownership. Never enumerate or remove other containers.
    if (!containerId) {
      try {
        const inspection = await docker(['inspect', name], { allowFailure: true });
        if (inspection.code === 0) {
          const item = JSON.parse(inspection.stdout)[0];
          if (item.Config?.Labels?.['io.refund-office.run'] === runId) containerId = item.Id;
        }
      } catch { /* No owned container was identified. */ }
    }
    if (containerId) {
      try { await docker(['rm', '--force', '--volumes', containerId]); cleanedUp = true; }
      catch (error) { fatal = [fatal, 'Owned container cleanup failed: ' + error.message].filter(Boolean).join(' '); }
    }
    rmSync(dockerConfig, { recursive: true, force: true });
    const record = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), passed: !fatal && checks.every(item => item.passed),
      scope: 'Real PostgreSQL SQL execution in a newly created disposable local container. Identity is a test-only auth.uid stub; no Supabase API, JWT verification, cloud account, provider request or payment submission is tested.',
      database: { image: IMAGE, imageId, containerName: name, containerId, network: 'none', localUnixSocket: true, existingDataMounts: false, cleanedUp },
      execution: { sqlRoundTrips, statementHashes, expectedFailures }, checks, fatal };
    writeFileSync(join(evidenceDir, 'verification.json'), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(join(evidenceDir, 'execution.log'), log.join('\n') + (fatal ? '\nFATAL ' + fatal : '') + '\n');
  }
  if (fatal) throw new Error(fatal);
  return { passed: true, checks: checks.length, evidence: join(evidenceDir, 'verification.json') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupabaseRuntimeChecks().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
