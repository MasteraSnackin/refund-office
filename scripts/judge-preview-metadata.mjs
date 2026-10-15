import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shellQuote = value => /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
function safePath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Preview metadata paths cannot contain symbolic links.');
    if (dirname(current) === current) break;
  }
}
export function judgeResumeCommand({ packId, ports, runId, baseDirectory, defaultBaseDirectory }) {
  if (!UUID.test(runId || '')) return null;
  const custom = resolve(baseDirectory) !== resolve(defaultBaseDirectory) ? ['--data-directory', resolve(baseDirectory)] : [];
  return ['node', 'scripts/run-judge-rehearsal.mjs', packId, '--ports', String(ports.ui), String(ports.api), ...custom, '--reuse', runId].map(shellQuote).join(' ');
}

// This file is a local handover aid. The running API and saved reset journal
// remain authoritative; publication cannot approve, reset or restore a run.
export function createJudgePreviewMetadata({ directory, ports, packId, baseDirectory, defaultBaseDirectory, ownerId = randomUUID(), now = () => new Date().toISOString() }) {
  if (!UUID.test(ownerId) || !['focused-12', 'busy-50'].includes(packId) || !ports || !['ui', 'api'].every(key => Number.isInteger(ports[key]) && ports[key] >= 1024 && ports[key] <= 65535) || ports.ui === ports.api) throw new Error('Use a known pack, distinct ports and preview owner.');
  directory = resolve(directory); safePath(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${ports.ui}-${ports.api}.json`), lockPath = path + '.lock';
  const url = `http://127.0.0.1:${ports.ui}/`, apiUrl = `http://127.0.0.1:${ports.api}`;
  let claimed = false;
  const retained = new Set();
  function publish(state) {
    if (state.packId !== packId || !UUID.test(state.runId || '') || !UUID.test(state.initialRunId || '') || !['starting', 'ready', 'switching', 'failed', 'unresolved'].includes(state.state) || !['starting', 'running', 'stopping', 'stopped', 'failed'].includes(state.lifecycle)) throw new Error('The preview state does not match its launcher.');
    if (state.reset?.checkpointConfirmed && UUID.test(state.reset.sourceRunId || '')) retained.add(state.reset.sourceRunId);
    const canResume = state.state === 'ready' && ['running', 'stopped'].includes(state.lifecycle) && (state.exitCode === null || state.exitCode === 0);
    const record = { schemaVersion: 1, ownerId, pid: process.pid, url, apiUrl, ports: { ...ports }, packId, initialRunId: state.initialRunId, runId: state.runId,
      lifecycle: state.lifecycle, exitCode: state.exitCode, status: state.lifecycle === 'running' ? state.state : state.lifecycle, resetState: state.state, reset: state.reset,
      retainedRunIds: [...retained], canResume, resumeCommand: canResume ? judgeResumeCommand({ packId, ports, runId: state.runId, baseDirectory, defaultBaseDirectory }) : null,
      externalServices: 'disabled', paymentSubmission: false, purpose: 'Separate saved judge-mode rehearsal', updatedAt: now(),
      note: 'A saved status is not a liveness check. Inspect the current API and reset journal before recovery.' };
    safePath(path); safePath(lockPath);
    // Port ownership is established by the launcher before its first publish.
    // Serialise replacement so a delayed old writer cannot overwrite its successor.
    const lock = openSync(lockPath, 'wx', 0o600);
    const next = path + '.' + ownerId + '.' + randomUUID() + '.next';
    try {
      if (claimed && (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).ownerId !== ownerId)) throw new Error('A different launcher owns this preview record.');
      const encoded = JSON.stringify(record, null, 2) + '\n';
      writeFileSync(next, encoded, { flag: 'wx', mode: 0o600 });
      const fd = openSync(next, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(next, path); claimed = true;
      const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      if (readFileSync(path, 'utf8') !== encoded) throw new Error('The saved preview status did not read back exactly.');
      return record;
    } finally {
      if (existsSync(next)) rmSync(next);
      closeSync(lock); rmSync(lockPath);
    }
  }
  return { path, ownerId, publish };
}
