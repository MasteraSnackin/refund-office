import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDemo } from '../scripts/prepare-demo.mjs';
import { createStore } from '../server/store.mjs';
import { demoEnvironment, isPortInUse, launcherExitCode } from '../scripts/run-demo.mjs';
import { loadDevEnvironment } from '../scripts/dev.mjs';
import { createServer } from 'node:net';

test('preparing both packs creates isolated queued cases and leaves repeated preparation unchanged', t => {
  const directory = mkdtempSync(join(tmpdir(), 'refund-demo-launch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [packId, count] of [['focused-12', 12], ['busy-50', 50]]) {
    const first = prepareDemo({ packId, baseDirectory: directory });
    assert.equal(first.caseCount, count); assert.equal(first.created, true);
    const store = createStore({ dbPath: first.dbPath });
    assert.equal(store.cases().length, count);
    assert.ok(store.cases().every(c => c.status === 'ready' && !c.approval && !c.receipt));
    assert.equal(store.intakeRequests().length, count);
    store.close();
    const before = readFileSync(first.dbPath);
    const repeated = prepareDemo({ packId, baseDirectory: directory });
    assert.equal(repeated.created, false); assert.equal(repeated.dbPath, first.dbPath);
    assert.deepEqual(readFileSync(first.dbPath), before);
    const fresh = prepareDemo({ packId, baseDirectory: directory, fresh: true });
    assert.notEqual(fresh.dbPath, first.dbPath); assert.equal(fresh.created, true);
    assert.deepEqual(readFileSync(first.dbPath), before);
  }
});

test('unknown pack names cannot select or mutate arbitrary database paths', () => {
  for (const packId of [undefined, '../../refund-office', 'main', 'busy-51']) {
    assert.throws(() => prepareDemo({ packId }), /Choose the focused-12 or busy-50/);
  }
});

test('demo launch overrides online selections and dev removes ambient credentials', () => {
  const prepared = { dbPath: '/tmp/synthetic.sqlite', packId: 'focused-12', datasetDigest: 'a'.repeat(64) };
  const env = demoEnvironment(prepared, { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'openai', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'supabase', OPENAI_API_KEY: 'fake-test-only', STRIPE_SECRET_KEY: 'fake-test-only', DB_PATH: '/tmp/ordinary.sqlite' });
  assert.equal(env.DB_PATH, prepared.dbPath);
  assert.equal(env.REFUND_OFFICE_DEMO_PACK, prepared.packId);
  assert.equal(env.REFUND_OFFICE_DEMO_DIGEST, prepared.datasetDigest);
  assert.equal(env.REFUND_OFFICE_NETWORK, 'offline');
  assert.equal(env.REFUND_OFFICE_ANALYSER, 'local');
  assert.equal(env.REFUND_OFFICE_ENABLED_INTEGRATIONS, '');
  const dev = loadDevEnvironment({ source: env, readFile() { throw new Error('Secret files must not be read'); } });
  assert.equal(dev.OPENAI_API_KEY, undefined);
  assert.equal(dev.STRIPE_SECRET_KEY, undefined);
});

test('port check detects a local listener and an abnormal child exit remains a failure', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.equal(await isPortInUse(server.address().port), true);
  assert.equal(launcherExitCode(null, 'SIGKILL'), 1);
  assert.equal(launcherExitCode(null, 'SIGTERM'), 143);
  assert.equal(launcherExitCode(null, 'SIGTERM', true), 0);
  assert.equal(launcherExitCode(2, null), 2);
});
