import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This helper never prints keys or raw CLI output and never opens a browser.
// Import: STRIPE_SECRET_KEY in the environment, then node scripts/setup-sandbox.mjs.
// Provision: node scripts/setup-sandbox.mjs --email <explicitly supplied email>.
const directory = join(homedir(), '.config', 'refund-office');
const destination = join(directory, 'sandbox.env');

function runProvision(config, email) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    delete childEnv.STRIPE_API_KEY;
    delete childEnv.STRIPE_SECRET_KEY;
    const child = spawn('npx', ['--yes', '@stripe/cli@1.53.1', '--config', config, '--color', 'off', 'sandbox', 'create', '--non-interactive', '--email', email], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let blocked = false;
    const timer = setTimeout(() => { blocked = true; child.kill('SIGTERM'); }, 60000);
    const collect = (chunk) => {
      output += chunk.toString();
      if (/falling back|opening browser|log in|login|sign.?up|accept.{0,20}terms/i.test(chunk.toString()) || output.length > 100000) { blocked = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Stripe CLI could not start. No key was saved.')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (blocked || code !== 0) return reject(new Error('Automatic provisioning did not complete. A supplied Stripe test key is needed; no browser sign-in was attempted.'));
      const key = output.match(/\b(?:sk|rk)_test_[A-Za-z0-9]+\b/)?.[0];
      resolve(key);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Import STRIPE_SECRET_KEY from the process environment, or use --email with an explicitly supplied address to provision a temporary test sandbox. Keys are saved only to ~/.config/refund-office/sandbox.env with mode 0600. Existing keys are preserved. No live keys or account login are supported.\n');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--email' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args[1]))) throw new Error('Use --email with an explicitly supplied email address, or supply a test key through the environment.');
  let key = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '').trim();
  if (!key && !args.length) throw new Error('A Stripe test key or an explicit email address is required. Nothing was provisioned.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try { await readFile(destination); throw new Error('A saved sandbox key already exists. It was preserved.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!key) {
    const temporary = await mkdtemp(join(directory, '.provision-'));
    try {
      await chmod(temporary, 0o700);
      key = await runProvision(join(temporary, 'config.toml'), args[1]);
      if (!key) {
        const config = await readFile(join(temporary, 'config.toml'), 'utf8');
        key = config.match(/\b(?:sk|rk)_test_[A-Za-z0-9]+\b/)?.[0];
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key || '')) throw new Error('Only Stripe test keys are accepted. No key was saved.');
  let response;
  try { response = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('The sandbox key could not be verified. No key was saved.'); }
  if (!response.ok) throw new Error(`Stripe rejected verification (HTTP ${response.status}). No key was saved.`);
  let balance;
  try { balance = await response.json(); } catch { throw new Error('Stripe returned an unreadable verification response. No key was saved.'); }
  if (balance.livemode !== false) throw new Error('Stripe did not confirm test mode. No key was saved.');
  await writeFile(destination, `STRIPE_SECRET_KEY=${key}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(destination, 0o600);
  process.stdout.write(`Verified test key saved securely: ${destination}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
