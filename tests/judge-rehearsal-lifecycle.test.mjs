import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { startJudgeRehearsal, parseJudgeArguments } from '../scripts/run-judge-rehearsal.mjs';
import { runEvidenceDemo } from '../scripts/run-evidence-demo.mjs';
import { createDemoResetControl } from '../server/demo-reset-control.mjs';
import { createJudgePreviewMetadata, judgeResumeCommand } from '../scripts/judge-preview-metadata.mjs';
import { contentHash } from '../server/supabase-import.mjs';

const reviewer = { userId: randomUUID(), role: 'reviewer' }, digest = 'a'.repeat(64);
function temporary(t) { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'refund-judge-lifecycle-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function ports() { const api = await freePort(); let ui; do { ui = await freePort(); } while (ui === api); return { api, ui }; }
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function savedHandle(dir, id, packId = 'focused-12') {
  const markerPath = join(dir, id + '.json');
  return { id, tenantId: id, packId, datasetDigest: digest, markerPath,
    server: createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ runId: id })); }),
    async quiesce() {},
    async stop() { const marker = { id, status: 'ready', datasetDigest: digest, lastStoppedAt: new Date().toISOString(), checkpoint: { sha256: 'b'.repeat(64) } }; writeFileSync(markerPath, JSON.stringify({ ...marker, markerSha256: contentHash(marker) })); return 0; },
  };
}
async function judgeFixture(t, options = {}) {
  const dir = options.dir || temporary(t), configuredPorts = await ports(), logs = [], warnings = [], launches = [], uiConfigurations = []; let backend;
  const launch = async args => {
    assert.equal(args.printResumeCommand, false); assert.equal(args.serve, false); assert.equal(args.installSignalHandlers, false);
    launches.push(args); const handle = savedHandle(dir, args.newId || args.reuseId, args.packId);
    await options.onLaunch?.(args, handle, launches.length); return handle;
  };
  const handle = await startJudgeRehearsal({ packId: 'focused-12', ports: configuredPorts, baseDirectory: join(dir, 'data'), metadataDirectory: join(dir, 'metadata'), cacheDirectory: join(dir, 'cache'), installSignalHandlers: false,
    runDemo: async args => { backend = await runEvidenceDemo({ ...args, launch }); return backend; },
    createUi: async configuration => { uiConfigurations.push(configuration); return { async listen() {}, async close() { await options.closeUi?.(); } }; },
    log: message => logs.push(message), warn: message => warnings.push(message),
  });
  t.after(() => handle.stop());
  const reset = async () => {
    const command = { commandId: randomUUID(), expectedRunId: handle.id };
    handle.control.forRun(handle.id).reset(reviewer, command); await handle.control.waitForIdle(); return command;
  };
  return { dir, handle, backend, reset, logs, warnings, launches, uiConfigurations, ports: configuredPorts };
}

test('judge supervisor follows repeated resets in API, current identity, metadata and shutdown command', async t => {
  const f = await judgeFixture(t), original = f.handle.id;
  assert.equal(read(f.handle.metadataPath).runId, original); assert.equal(f.handle.initialRunId, original);
  assert.equal(read(f.handle.metadataPath).status, 'ready');
  await f.reset(); const second = f.handle.id; assert.notEqual(second, original);
  assert.equal((await (await fetch(f.handle.apiUrl)).json()).runId, second);
  await f.reset(); const third = f.handle.id; assert.notEqual(third, second);
  const current = read(f.handle.metadataPath);
  assert.equal(current.runId, third); assert.equal(current.initialRunId, original); assert.equal(current.status, 'ready'); assert.equal(current.canResume, true);
  assert.deepEqual(current.retainedRunIds, [original, second]); assert.match(current.resumeCommand, new RegExp('--reuse ' + third + '$'));
  assert.match(current.resumeCommand, /--data-directory /); assert.equal(f.launches.length, 3);
  assert.equal(f.handle.snapshot().runId, third); assert.equal(f.handle.snapshot().reset.targetRunId, third);
  assert.equal(await f.handle.stop(), 0);
  const stopped = read(f.handle.metadataPath); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.runId, third); assert.equal(stopped.resumeCommand, current.resumeCommand);
  const commands = f.logs.filter(message => message.startsWith('Resume the current'));
  assert.equal(commands.length, 4); assert.match(commands.at(-1), new RegExp(third + '$'));
  assert.ok(f.logs.every(message => !message.includes('node scripts/run-evidence-rehearsal.mjs'))); assert.deepEqual(f.warnings, []);
  assert.deepEqual(readdirSync(join(f.dir, 'metadata')), [`${f.ports.ui}-${f.ports.api}.json`]);
});

test('simultaneous judge previews keep separate metadata and Vite caches', async t => {
  const dir = temporary(t), first = await judgeFixture(t, { dir }), second = await judgeFixture(t, { dir });
  assert.notEqual(first.handle.metadataPath, second.handle.metadataPath); assert.notEqual(first.handle.cacheDirectory, second.handle.cacheDirectory);
  assert.equal(first.uiConfigurations[0].cacheDir, first.handle.cacheDirectory); assert.equal(second.uiConfigurations[0].cacheDir, second.handle.cacheDirectory);
  const before = readFileSync(second.handle.metadataPath, 'utf8');
  await first.reset(); await first.handle.stop();
  assert.equal(readFileSync(second.handle.metadataPath, 'utf8'), before);
  assert.equal((await (await fetch(second.handle.apiUrl)).json()).runId, second.handle.id);
});

for (const trigger of ['launcher', 'backend']) test(`${trigger} shutdown preserves an interface-close failure while still stopping the backend`, async t => {
  let f;
  f = await judgeFixture(t, { closeUi() {
    const during = read(f.handle.metadataPath); assert.equal(during.status, 'stopping'); assert.equal(during.resumeCommand, null);
    throw new Error('Private interface cleanup error');
  } });
  if (trigger === 'launcher') assert.equal(await f.handle.stop(), 1);
  else assert.equal(await f.backend.stop(), 0);
  assert.equal(await f.handle.done, 1); assert.equal(await f.backend.done, 0); assert.equal(await f.handle.stop(), 1);
  assert.equal(f.handle.snapshot().lifecycle, 'failed'); assert.equal(f.handle.snapshot().exitCode, 1);
  const saved = read(f.handle.metadataPath); assert.equal(saved.status, 'failed'); assert.equal(saved.exitCode, 1); assert.equal(saved.resumeCommand, null);
  assert.equal(f.logs.filter(message => message.startsWith('Resume the current')).length, 1);
  assert.ok(f.warnings.some(message => message.includes('interface did not close cleanly')));
  assert.doesNotMatch(JSON.stringify(saved) + f.warnings.join(' '), /Private interface cleanup error/);
  await assert.rejects(fetch(f.handle.apiUrl));
});

test('signal-triggered completion uses the whole launcher result for the CLI exit status', t => {
  const dir = temporary(t), launcherUrl = new URL('../scripts/run-judge-rehearsal.mjs', import.meta.url).href;
  const script = `
    import { startJudgeRehearsal } from ${JSON.stringify(launcherUrl)};
    import { readFileSync } from 'node:fs';
    const id = '90000000-0000-4000-8000-000000000001';
    const handle = await startJudgeRehearsal({ ports: { ui: 5873, api: 5874 }, baseDirectory: ${JSON.stringify(join(dir, 'data'))}, metadataDirectory: ${JSON.stringify(join(dir, 'metadata'))}, cacheDirectory: ${JSON.stringify(join(dir, 'cache'))},
      runDemo: async options => {
        let finish; const done = new Promise(resolve => { finish = resolve; });
        let state = { packId: 'focused-12', runId: id, initialRunId: id, state: 'ready', reset: null, lifecycle: 'running', exitCode: null };
        options.onStateChange(state);
        return { id, initialRunId: id, apiUrl: 'http://127.0.0.1:5874', snapshot: () => state, done, async stop() { state = { ...state, lifecycle: 'stopped', exitCode: 0 }; options.onStateChange(state); finish(0); return 0; } };
      },
      createUi: async () => ({ async listen() {}, async close() { throw new Error('Injected close failure'); } }), log() {}, warn() {} });
    process.emit('SIGTERM');
    process.exitCode = await handle.done;
    const saved = JSON.parse(readFileSync(handle.metadataPath, 'utf8'));
    console.log(JSON.stringify({ status: saved.status, exitCode: saved.exitCode, resumeCommand: saved.resumeCommand }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr); assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'failed', exitCode: 1, resumeCommand: null });
});

test('failed final reset journal is never advertised as ready even when the current handle is the target', async t => {
  const f = await judgeFixture(t, { onLaunch(args, _handle, count) {
    if (count > 1) {
      const journal = join(args.baseDirectory, 'reset-commands');
      const command = readdirSync(journal).find(name => name.endsWith('.json'));
      writeFileSync(join(journal, command + '.next'), 'Interrupted final write');
    }
  } });
  const source = f.handle.id, command = await f.reset(); assert.notEqual(f.handle.id, source);
  const result = f.handle.control.forRun(source).status(command.commandId);
  assert.equal(result.status, 'unresolved'); assert.equal(result.targetRunId, f.handle.id);
  const record = read(f.handle.metadataPath);
  assert.equal(record.runId, f.handle.id); assert.equal(record.status, 'unresolved'); assert.equal(record.resetState, 'unresolved');
  assert.equal(record.canResume, false); assert.equal(record.resumeCommand, null);
  assert.equal(f.logs.filter(message => message.startsWith('Resume the current')).length, 1);
  await f.handle.stop(); const stopped = read(f.handle.metadataPath); assert.equal(stopped.resetState, 'unresolved'); assert.equal(stopped.resumeCommand, null);
});

test('failed replacement launch retains source identity without a ready status or restart command', async t => {
  const f = await judgeFixture(t, { onLaunch(_args, _handle, count) { if (count > 1) throw new Error('Private launch failure'); } });
  const source = f.handle.id; await f.reset(); const record = read(f.handle.metadataPath);
  assert.equal(record.runId, source); assert.equal(record.status, 'failed'); assert.equal(record.resumeCommand, null); assert.equal(record.reset.checkpointConfirmed, true);
  assert.doesNotMatch(JSON.stringify(record), /Private launch failure/);
});

test('passive synchronous and asynchronous observer failures do not change the saved reset result', async t => {
  const dir = temporary(t), source = savedHandle(dir, randomUUID()), target = savedHandle(dir, randomUUID()); let observations = 0;
  const control = createDemoResetControl({ journalDirectory: join(dir, 'journal'), packId: 'focused-12', newId: () => target.id, launch: async () => target,
    onStateChange() { if (++observations % 2) throw new Error('Observer failure'); return Promise.reject(new Error('Async observer failure')); },
  });
  control.attachInitial(source); const command = { commandId: randomUUID(), expectedRunId: source.id };
  control.forRun(source.id).reset(reviewer, command); await control.waitForIdle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.current(), target); assert.equal(control.snapshot().state, 'ready'); assert.equal(control.forRun(source.id).status(command.commandId).status, 'ready'); assert.equal(observations, 4);
});

test('metadata ownership stops a delayed old writer from overwriting a replacement preview', t => {
  const dir = temporary(t), configuredPorts = { ui: 5773, api: 5774 };
  const options = { directory: dir, ports: configuredPorts, packId: 'focused-12', baseDirectory: dir, defaultBaseDirectory: dir };
  const first = createJudgePreviewMetadata(options), second = createJudgePreviewMetadata(options);
  const state = id => ({ packId: 'focused-12', runId: id, initialRunId: id, state: 'ready', reset: null, lifecycle: 'running', exitCode: null });
  const before = state(randomUUID()); first.publish(before); const current = state(randomUUID()); second.publish(current);
  const bytes = readFileSync(second.path, 'utf8');
  assert.throws(() => first.publish({ ...before, lifecycle: 'stopped', exitCode: 0 }), /different launcher owns/);
  assert.equal(readFileSync(second.path, 'utf8'), bytes); assert.equal(read(second.path).runId, current.runId);
});

test('metadata write failure is reported without changing a confirmed reset', async t => {
  const f = await judgeFixture(t); const initial = f.handle.id;
  writeFileSync(f.handle.metadataPath + '.lock', 'A separate writer or interrupted publication');
  await f.reset(); assert.notEqual(f.handle.id, initial); assert.equal(f.handle.snapshot().state, 'ready');
  assert.equal(f.handle.control.forRun(initial).status(f.handle.snapshot().reset.commandId).status, 'ready');
  assert.ok(f.warnings.length > 0); rmSync(f.handle.metadataPath + '.lock'); await f.handle.stop();
  assert.equal(read(f.handle.metadataPath).runId, f.handle.id); assert.equal(read(f.handle.metadataPath).status, 'stopped');
});

test('custom-directory restart command preserves literal shell arguments and the parser accepts its options', t => {
  const dir = temporary(t), baseDirectory = join(dir, "Rehearsal's $(printf not-executed)"), runId = randomUUID(), configuredPorts = { ui: 5773, api: 5774 };
  const command = judgeResumeCommand({ packId: 'focused-12', ports: configuredPorts, runId, baseDirectory, defaultBaseDirectory: dir });
  const result = spawnSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
  assert.equal(result.status, 0); const args = result.stdout.trimEnd().split('\n');
  assert.deepEqual(parseJudgeArguments(args.slice(2)), { packId: 'focused-12', ports: configuredPorts, reuseId: runId, baseDirectory });
  assert.ok(args.includes(baseDirectory));
  for (const args of [['focused-12', '--ports', '5773', '5773'], ['focused-12', '--reuse', 'invalid'], ['focused-12', '--data-directory'], ['focused-12', '--ports', '5773', '5774', '--ports', '5873', '5874']]) assert.throws(() => parseJudgeArguments(args));
});

test('importing all rehearsal launchers starts no preview or command-line work', t => {
  const dir = temporary(t), urls = ['run-judge-rehearsal.mjs', 'run-evidence-demo.mjs', 'run-evidence-rehearsal.mjs'].map(name => new URL('../scripts/' + name, import.meta.url).href);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const url of ${JSON.stringify(urls)}) await import(url); console.log('imports-only');`], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'imports-only'); assert.deepEqual(readdirSync(dir), []);
});
