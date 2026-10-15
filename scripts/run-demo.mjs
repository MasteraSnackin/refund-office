import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { prepareDemo, projectRoot } from './prepare-demo.mjs';

export function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.once('timeout', () => finish(true));
  });
}

export function demoEnvironment(prepared, source = process.env) {
  return { ...source, DB_PATH: prepared.dbPath, API_PORT: '4174', REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_ENABLED_INTEGRATIONS: '', REFUND_OFFICE_DEMO_PACK: prepared.packId, REFUND_OFFICE_DEMO_DIGEST: prepared.datasetDigest };
}

export function launcherExitCode(code, signal, stopping = false) {
  if (Number.isInteger(code)) return code;
  return stopping ? 0 : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

export async function runDemo({ packId, fresh = false } = {}) {
  if ((await Promise.all([isPortInUse(4173), isPortInUse(4174)])).some(Boolean)) {
    throw new Error('A local preview is already using the demo ports. Stop its server before switching packs. No saved data has been changed.');
  }
  const prepared = prepareDemo({ packId, fresh });
  console.log(`${prepared.title}. Background investigation stops for a human decision. All sponsor connections are disabled.`);
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: projectRoot, stdio: 'inherit',
    env: demoEnvironment(prepared),
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; child.kill('SIGTERM'); });
  child.once('error', () => { console.error('The local demo could not start. Its saved cases remain available.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = launcherExitCode(code, signal, stopping); });
  return child;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [packId, ...options] = process.argv.slice(2);
  if (options.some(option => option !== '--fresh')) { console.error('Use the pack name and optional --fresh.'); process.exitCode = 1; }
  else runDemo({ packId, fresh: options.includes('--fresh') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
