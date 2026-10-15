import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { contentHash } from '../server/supabase-import.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function sources() {
  const files = new Map();
  function visit(path) {
    const absolute = resolve(ROOT, path), key = relative(ROOT, absolute);
    assert.ok(absolute.startsWith(ROOT));
    if (files.has(key)) return;
    const bytes = readFileSync(absolute);
    files.set(key, { path: key, bytes: bytes.length, sha256: sha256(bytes) });
    if (!/\.[cm]?js$/.test(path)) return;
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      visit(relative(ROOT, resolve(dirname(absolute), match[1])));
    }
  }
  for (const path of ['scripts/test-judge-rehearsal.mjs', 'scripts/run-judge-rehearsal.mjs', 'tests/supabase-runtime/bootstrap.sql', 'demo-data/focused-12.json', 'integrations/supabase/runtime/001_runtime.sql', 'integrations/supabase/runtime/002_office_workflow.sql', 'integrations/supabase/runtime/007_evidence_clarification.sql']) visit(path);
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { digest: sha256(JSON.stringify(list)), files: list };
}

export async function testJudgeRehearsal() {
  const outputBase = join(ROOT, 'work/judge-lifecycle');
  mkdirSync(outputBase, { recursive: true });
  const output = mkdtempSync(join(outputBase, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const baseDirectory = join(output, 'runs');
  const metadataDirectory = join(output, 'previews'), cacheDirectory = join(output, 'vite-cache');
  const before = sources(), checks = [], ownedIds = new Set(), handles = new Set(), checkpointCounts = [];
  write(join(output, 'sources-before.json'), before);
  const { startJudgeRehearsal } = await import('./run-judge-rehearsal.mjs');
  const { validateOwnedVolume, runtimeRehearsalEnvironment } = await import('./run-evidence-rehearsal.mjs');
  const nativeFetch = globalThis.fetch;
  const allowedOrigins = new Set([5073, 5074, 5173, 5174].map(port => `http://127.0.0.1:${port}`));
  let externalFetchAttempts = 0;
  globalThis.fetch = (url, options) => {
    const local = allowedOrigins.has(new URL(url).origin);
    if (!local) externalFetchAttempts++;
    assert.ok(local, 'Only the owned local rehearsal can be contacted.');
    return nativeFetch(url, options);
  };
  let first, second, firstSession, secondSession, initialId, finalId, finalCases, error = null, cleaned = false;
  async function launch(ports, reuseId) {
    const handle = await startJudgeRehearsal({ packId: 'focused-12', ports, reuseId, baseDirectory, metadataDirectory, cacheDirectory, installSignalHandlers: false });
    handles.add(handle); ownedIds.add(handle.id);
    return handle;
  }
  async function stop(handle) { assert.equal(await handle.stop(), 0); handles.delete(handle); }
  function metadata(handle) { return JSON.parse(readFileSync(handle.metadataPath, 'utf8')); }
  function client(ports) {
    let runId, cookie;
    async function request(path, { method = 'GET', body, authenticated = true, fence = true } = {}) {
      const response = await fetch(`http://127.0.0.1:${ports.api}${path}`, {
        method, headers: { Origin: `http://127.0.0.1:${ports.ui}`, ...(fence && runId ? { 'x-refund-demo-run': runId } : {}), ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    }
    return {
      request,
      async login() {
        const discovery = await request('/api/session', { authenticated: false, fence: false });
        assert.equal(discovery.status, 200); runId = discovery.body.demoRun.id;
        const response = await request('/api/session', { method: 'POST', body: { profileId: 'reviewer' }, authenticated: false });
        assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0];
        return runId;
      },
      async settled() {
        const deadline = Date.now() + 60000;
        for (;;) {
          const result = await request('/api/bootstrap'); assert.equal(result.status, 200);
          if (result.body.cases.length === 12 && result.body.intakeRequests.every(item => !['queued', 'investigating'].includes(item.status)) && !result.body.runtime.worker.active) return result.body;
          if (Date.now() > deadline) throw Error('The isolated judge queue did not settle.');
          await delay(150);
        }
      },
      async reset(handle) {
        const command = { commandId: randomUUID(), expectedRunId: runId };
        const response = await request('/api/demo/reset', { method: 'POST', body: command }); assert.equal(response.status, 202);
        const deadline = Date.now() + 60000;
        let receipt;
        for (;;) {
          const saved = await request('/api/demo/reset/' + command.commandId, { authenticated: false, fence: false }); assert.equal(saved.status, 200);
          receipt = saved.body;
          if (receipt.targetRunId) ownedIds.add(receipt.targetRunId);
          if (receipt.status !== 'switching') break;
          if (Date.now() > deadline) throw Error('The isolated judge reset did not finish.');
          await delay(150);
        }
        assert.equal(receipt.status, 'ready'); assert.equal(receipt.checkpointConfirmed, true);
        assert.equal(handle.id, receipt.targetRunId);
        return receipt;
      },
    };
  }
  async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name); }
  function assertUnapproved(data) {
    assert.equal(data.capabilities.networkMode, 'offline'); assert.equal(data.capabilities.paymentSubmission, false);
    for (const item of data.cases) {
      assert.ok(!item.approval || item.approval.state === 'required');
      assert.ok(!item.operationId || item.receipt?.seeded === true);
      assert.ok(!item.receipt || item.receipt.seeded === true);
    }
  }
  async function cleanup() {
    let endpoint;
    for (const socket of [join(homedir(), '.docker/run/docker.sock'), '/var/run/docker.sock']) {
      try { if (statSync(socket).isSocket()) { endpoint = 'unix://' + socket; break; } } catch { /* Try the other local socket. */ }
    }
    assert.ok(endpoint);
    const config = join(output, 'empty-docker-config'); mkdirSync(config, { mode: 0o700 });
    async function docker(args, allowFailure = false) {
      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn('docker', ['--host', endpoint, '--config', config, ...args], { cwd: ROOT, env: runtimeRehearsalEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
        child.once('error', reject); child.once('close', code => resolvePromise({ code, stdout, stderr }));
      });
      if (!allowFailure) assert.equal(result.code, 0, 'Owned judge-test Docker action failed.');
      return result;
    }
    // This directory was created inside this test's fresh output directory.
    // Include an interrupted launch that created its marker before returning.
    if (existsSync(baseDirectory)) for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.name)) ownedIds.add(entry.name);
    }
    const cleanupErrors = [];
    for (const id of ownedIds) { try {
      const directory = join(baseDirectory, id), path = join(directory, 'rehearsal.json');
      if (!existsSync(directory)) continue;
      assert.ok(existsSync(path), 'Retain an interrupted run without a verifiable marker: ' + id);
      const marker = JSON.parse(readFileSync(path)); assert.equal(marker.id, id);
      const { markerSha256, ...payload } = marker; assert.equal(markerSha256, contentHash(payload), 'The retained marker must verify before its checkpoint is used.');
      assert.equal(existsSync(join(directory, 'active.json')), false, 'The test must stop its run before cleanup.');
      assert.equal(marker.checkpoint?.counts?.approvals, 0, 'The test must create no refund approvals.');
      assert.equal(marker.checkpoint?.counts?.operations, 1, 'Only the one historical seed operation may exist.');
      checkpointCounts.push({ id, approvals: marker.checkpoint.counts.approvals, operations: marker.checkpoint.counts.operations });
      const found = await docker(['volume', 'inspect', marker.volumeName], true);
      if (found.code === 0) {
        validateOwnedVolume(JSON.parse(found.stdout)[0], marker);
        assert.equal((await docker(['ps', '--all', '--filter', 'volume=' + marker.volumeName, '--format', '{{.ID}}'])).stdout.trim(), '');
        await docker(['volume', 'rm', marker.volumeName]);
        const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim().split('\n');
        assert.equal(names.includes(marker.volumeName), false, 'Removal must be confirmed by a successful volume listing.');
      } else {
        const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim().split('\n');
        assert.equal(names.includes(marker.volumeName), false, 'A failed inspect does not establish absence.');
      }
      write(join(output, 'checkpoint-' + id + '.json'), marker);
      rmSync(directory, { recursive: true });
    } catch (failure) { cleanupErrors.push(id + ': ' + failure.message); } }
    rmSync(config, { recursive: true, force: true });
    if (cleanupErrors.length) throw Error(cleanupErrors.join('; '));
    cleaned = true;
  }
  try {
    await check('two live judge previews retain separate identities, metadata and local interfaces', async () => {
      first = await launch({ ui: 5073, api: 5074 }); initialId = first.id;
      second = await launch({ ui: 5173, api: 5174 });
      assert.notEqual(first.id, second.id); assert.notEqual(first.metadataPath, second.metadataPath);
      firstSession = client({ ui: 5073, api: 5074 }); secondSession = client({ ui: 5173, api: 5174 });
      assert.equal(await firstSession.login(), first.id); assert.equal(await secondSession.login(), second.id);
      assertUnapproved(await firstSession.settled()); assertUnapproved(await secondSession.settled());
      for (const port of [5073, 5173]) { const response = await fetch(`http://127.0.0.1:${port}/`); assert.equal(response.status, 200); assert.match(await response.text(), /root/); }
      assert.equal(metadata(first).runId, first.id); assert.equal(metadata(second).runId, second.id);
    });
    await check('saved brief explains evidence and earlier review without approving the clarified recommendation', async () => {
      const initial = await firstSession.settled(), item = initial.cases.find(value => value.caseId === 'RF-2008');
      const held = await firstSession.request('/api/cases/' + item.id + '/review', { method: 'POST', body: { action: 'request-evidence', expectedRevision: item.revision, note: 'Synthetic judge test: identify the missing item.', commandId: randomUUID() } }); assert.equal(held.status, 200);
      const context = await firstSession.request('/api/cases/' + item.id + '/evidence-request'); assert.equal(context.body.eligible, true);
      const clarification = await firstSession.request('/api/cases/' + item.id + '/evidence-request', { method: 'POST', body: { expectedRevision: context.body.revision, lineId: 'SYN-F12-O008-L1', customerStatement: 'The sketchbook is the missing item I am claiming.', sourceReference: 'Synthetic judge lifecycle reply', note: 'Fictional local verification input.', commandId: randomUUID() } }); assert.equal(clarification.status, 200);
      const saved = await firstSession.settled(); assertUnapproved(saved);
      const updated = saved.cases.find(value => value.id === item.id); assert.equal(updated.proposedAmountMinor, 1000); assert.equal(updated.outcome, 'awaiting-approval');
      const report = await firstSession.request('/api/cases/' + item.id + '/report'); assert.equal(report.status, 200);
      assert.match(report.body, /Sketchbook: 1 ordered, 0 recorded as packed/);
      assert.match(report.body, /Synthetic judge lifecycle reply/);
      assert.match(report.body, /Synthetic judge test: identify the missing item/);
      assert.doesNotMatch(report.body, /No human decision recorded/);
      assert.match(report.body, /approval.*required|requires.*approval|awaiting approval/i);
      writeFileSync(join(output, 'clarified-decision-brief.md'), report.body, { mode: 0o600 });
      const briefing = await firstSession.request('/api/cases/' + item.id + '/briefing'); assert.equal(briefing.status, 200);
      assert.doesNotMatch(JSON.stringify(briefing.body), /No human decision has been recorded/);
      assert.deepEqual((await firstSession.settled()).cases, saved.cases, 'Reading reports must not alter case state.');
    });
    await check('two resets update current identity and restart instruction without altering the other preview', async () => {
      const untouched = readFileSync(second.metadataPath, 'utf8');
      for (let index = 0; index < 2; index++) {
        const previousId = first.id, receipt = await firstSession.reset(first);
        const record = metadata(first);
        assert.equal(record.runId, receipt.targetRunId); assert.notEqual(record.runId, previousId);
        assert.match(record.resumeCommand, new RegExp('--reuse ' + record.runId));
        assert.match(record.resumeCommand, /--ports 5073 5074/); assert.match(record.resumeCommand, /run-judge-rehearsal/);
        assert.ok(record.resumeCommand.includes('--data-directory')); assert.ok(record.resumeCommand.includes(baseDirectory));
        assert.equal(await firstSession.login(), record.runId); assertUnapproved(await firstSession.settled());
        assert.equal(readFileSync(second.metadataPath, 'utf8'), untouched);
      }
      finalId = first.id; finalCases = (await firstSession.settled()).cases;
      assert.notEqual(finalId, initialId);
    });
    await check('shutdown and explicit restart retain the latest run and all saved case records', async () => {
      const untouched = readFileSync(second.metadataPath, 'utf8');
      await stop(first);
      assert.equal(metadata(first).runId, finalId); assert.match(metadata(first).resumeCommand, new RegExp('--reuse ' + finalId));
      assert.equal(readFileSync(second.metadataPath, 'utf8'), untouched);
      first = await launch({ ui: 5073, api: 5074 }, finalId);
      assert.equal(await firstSession.login(), finalId); assert.deepEqual((await firstSession.settled()).cases, finalCases);
      assertUnapproved(await secondSession.settled());
      await stop(first); await stop(second);
    });
  } catch (failure) { error = failure.message; console.error(failure.stack); }
  finally {
    for (const handle of [...handles]) {
      try { await stop(handle); } catch (failure) { error = [error, 'Owned stop: ' + failure.message].filter(Boolean).join('; '); }
    }
    try { await cleanup(); } catch (failure) { error = [error, 'Owned cleanup: ' + failure.message].filter(Boolean).join('; '); }
    globalThis.fetch = nativeFetch;
    const after = sources(); write(join(output, 'sources-after.json'), after);
    if (before.digest !== after.digest) error = [error, 'Sources changed during verification.'].filter(Boolean).join('; ');
    if (externalFetchAttempts) error = [error, 'A non-local fetch was attempted and blocked.'].filter(Boolean).join('; ');
    write(join(output, 'verification.json'), { passed: !error, checkedAt: new Date().toISOString(), checks, checksPassed: checks.length, initialId, finalId, ownedRunIds: [...ownedIds], packId: 'focused-12', externalFetchAttempts, externalFetchesSent: 0, checkpointCounts, historicalSeedOperationsPerRun: 1, newApprovals: checkpointCounts.length ? Math.max(...checkpointCounts.map(row => row.approvals)) : null, newOperations: checkpointCounts.length ? Math.max(...checkpointCounts.map(row => row.operations - 1)) : null, ownedTestVolumesRemoved: cleaned, sourceDigest: before.digest, sourceFiles: before.files.length, error });
  }
  console.log('Judge lifecycle verification: ' + join(output, 'verification.json'));
  if (error) throw Error(error);
  return { output, checks: checks.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) testJudgeRehearsal().catch(() => { process.exitCode = 1; });
