import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const credentialNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY', 'N8N_INTAKE_TOKEN', 'SUPABASE_PUBLISHABLE_KEY', 'MIRO_ACCESS_TOKEN', 'MODAL_EVIDENCE_TOKEN', 'PORT_ACCESS_TOKEN'];

// Merely having a key saved on this computer does not enable a connection.
export function loadDevEnvironment({ source = process.env, readFile = readFileSync, configDir = join(homedir(), '.config', 'refund-office') } = {}) {
  const env = { ...source };
  if (env.REFUND_OFFICE_NETWORK !== 'enabled') {
    for (const name of credentialNames) delete env[name];
    return env;
  }
  for (const file of ['sandbox.env', 'model.env']) {
    try {
      const content = readFile(join(configDir, file), 'utf8');
      for (const line of content.split('\n')) {
        const match = line.match(/^(OPENAI_API_KEY|OPENAI_MODEL|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID|ELEVENLABS_MODEL|STRIPE_SECRET_KEY|STRIPE_API_KEY)=(.*)$/);
        if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return env;
}

function startDev() {
  const env = loadDevEnvironment();
  const uiEnv = { ...process.env };
  for (const name of credentialNames) delete uiEnv[name];
  const children = [
    spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env }),
    spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173', '--strictPort', ...process.argv.slice(2)], { stdio: 'inherit', env: uiEnv }),
  ];
  let stopping = false;
  function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  children.forEach(child => { child.on('error', () => stop(1)); child.on('exit', code => stop(code || 0)); });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startDev();
