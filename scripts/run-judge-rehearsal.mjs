import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { runEvidenceDemo } from './run-evidence-demo.mjs';
import { createJudgePreviewMetadata } from './judge-preview-metadata.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA = join(ROOT, '.data/judge-runtime-rehearsals');
const DEFAULT_PORTS = Object.freeze({ ui: 4673, api: 4674 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validatePorts(ports) {
  if (!ports || !['ui', 'api'].every(key => Number.isInteger(ports[key]) && ports[key] >= 1024 && ports[key] <= 65535) || ports.ui === ports.api) throw new Error('Supply two different local ports from 1024 to 65535.');
}
export function parseJudgeArguments(values) {
  const [packId = 'focused-12', ...args] = values;
  if (!['focused-12', 'busy-50'].includes(packId)) throw new Error('Choose focused-12 or busy-50.');
  const ports = { ...DEFAULT_PORTS }, seen = new Set(); let reuseId, baseDirectory;
  while (args.length) {
    const flag = args.shift(); if (seen.has(flag)) throw new Error('Rehearsal options must not repeat.'); seen.add(flag);
    if (flag === '--reuse') { reuseId = args.shift(); if (!UUID.test(reuseId || '')) throw new Error('Supply the saved rehearsal UUID after --reuse.'); }
    else if (flag === '--ports') { for (const key of ['ui', 'api']) { const value = args.shift(); if (!/^[1-9][0-9]{3,4}$/.test(value || '')) throw new Error('Supply two different local ports from 1024 to 65535 after --ports.'); ports[key] = Number(value); } }
    else if (flag === '--data-directory') { const value = args.shift(); if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error('Supply a local data directory after --data-directory.'); baseDirectory = resolve(value); }
    else throw new Error('Supported options: --reuse UUID, --ports UI_PORT API_PORT and --data-directory PATH.');
  }
  validatePorts(ports); return { packId, ports, ...(reuseId ? { reuseId } : {}), ...(baseDirectory ? { baseDirectory } : {}) };
}

export async function startJudgeRehearsal({ packId = 'focused-12', reuseId, ports = DEFAULT_PORTS, baseDirectory = DEFAULT_DATA,
  metadataDirectory = join(ROOT, 'work/five-improvements/judge-previews'), cacheDirectory = join(ROOT, 'work/five-improvements/vite-cache'),
  installSignalHandlers = true, runDemo = runEvidenceDemo, createUi = createServer, log = console.log, warn = console.warn } = {}) {
  if (!['focused-12', 'busy-50'].includes(packId) || reuseId && !UUID.test(reuseId)) throw new Error('Use a known pack and optional saved run UUID.');
  validatePorts(ports); ports = Object.freeze({ ui: ports.ui, api: ports.api });
  baseDirectory = resolve(baseDirectory); metadataDirectory = resolve(metadataDirectory);
  const scopedCache = join(resolve(cacheDirectory), `${ports.ui}-${ports.api}`), url = `http://127.0.0.1:${ports.ui}/`;
  let handle, ui, stopping, metadata, latestState, lastPrinted, lifecycle = 'starting', exitCode = null, backendFailed = false;
  let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
  const signals = new Map();
  const reportFailure = () => { try { warn('Preview metadata could not be updated. Use the current API and saved reset journal before choosing a run to restore.'); } catch {} };
  function snapshot(state = latestState || handle?.snapshot()) {
    // The interface and API form one preview. Backend completion alone cannot
    // report successful shutdown while interface cleanup is still outstanding.
    const phase = lifecycle === 'running' && state?.lifecycle !== 'running' ? 'stopping' : lifecycle;
    return Object.freeze({ ...state, lifecycle: phase, exitCode });
  }
  function publish(state) {
    latestState = state;
    if (!metadata) return;
    let record;
    try { record = metadata.publish(snapshot(state)); } catch { reportFailure(); return; }
    const key = `${record.runId}:${record.lifecycle}:${record.status}`;
    if (record.resumeCommand && key !== lastPrinted) {
      lastPrinted = key; try { log(`Resume the current saved run after stopping this preview: ${record.resumeCommand}`); } catch {}
    }
  }
  async function stop() {
    if (stopping) return stopping;
    lifecycle = 'stopping'; if (latestState) publish(latestState);
    stopping = (async () => {
      for (const [signal, listener] of signals) process.removeListener(signal, listener);
      let code = 0;
      try { await ui?.close(); } catch {
        code = 1;
        try { warn('The interface did not close cleanly. The backend is being stopped; inspect the preview before restarting.'); } catch {}
      }
      try { const result = await handle?.stop(); if (result !== undefined && result !== 0) code = 1; } catch { code = 1; }
      exitCode = backendFailed ? 1 : code; lifecycle = exitCode === 0 ? 'stopped' : 'failed';
      if (latestState) publish(latestState);
      resolveDone(exitCode); return exitCode;
    })();
    return stopping;
  }
  try {
    handle = await runDemo({ packId, reuseId, baseDirectory, ports, serveUi: false, installSignalHandlers: false, onStateChange: publish, log, warn });
    ui = await createUi({ configFile: false, root: ROOT, envDir: false, cacheDir: scopedCache, plugins: [react()], optimizeDeps: { include: ['react', 'react-dom/client'] },
      server: { host: '127.0.0.1', port: ports.ui, strictPort: true, proxy: { '/api': 'http://127.0.0.1:' + ports.api }, allowedHosts: ['127.0.0.1', 'localhost'] } });
    await ui.listen();
    lifecycle = 'running';
    try { metadata = createJudgePreviewMetadata({ directory: metadataDirectory, ports, packId, baseDirectory, defaultBaseDirectory: DEFAULT_DATA }); publish(latestState || handle.snapshot()); } catch { reportFailure(); }
    log(`Judge rehearsal: ${url} . Separate saved pack; local rules; providers disconnected.`);
    if (installSignalHandlers) for (const signal of ['SIGINT', 'SIGTERM']) { const listener = () => { void stop(); }; signals.set(signal, listener); process.once(signal, listener); }
    Promise.resolve(handle.done).then(code => { if (code !== 0) backendFailed = true; void stop(); }, () => { backendFailed = true; void stop(); });
    return { get id() { return handle.id; }, initialRunId: handle.initialRunId, url, apiUrl: handle.apiUrl, metadataPath: metadata?.path || join(metadataDirectory, `${ports.ui}-${ports.api}.json`), cacheDirectory: scopedCache,
      control: handle.control, snapshot, stop, done };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const handle = await startJudgeRehearsal(parseJudgeArguments(process.argv.slice(2)));
    process.exitCode = await handle.done;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
