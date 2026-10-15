import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HANDOVER_SOURCE_FILES, prepareSponsorHandover } from '../scripts/prepare-sponsor-handover.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = data => createHash('sha256').update(data).digest('hex');
const read = (dir, path) => JSON.parse(readFileSync(resolve(dir, path), 'utf8'));
function temp(t) {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'refund-handover-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sourceCopy(t) {
  const root = temp(t);
  for (const path of HANDOVER_SOURCE_FILES) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    cpSync(resolve(projectDir, path), resolve(root, path));
  }
  // Referenced application files are checked for existence, never packaged. Use
  // empty public-reference stand-ins so these fixtures need no extra source copy.
  for (const path of HANDOVER_SOURCE_FILES.filter(path => path.endsWith('.md'))) {
    for (const match of readFileSync(resolve(root, path), 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(match[1])) continue;
      const original = resolve(projectDir, dirname(path), match[1].split('#')[0]);
      const reference = relative(projectDir, original);
      if (!original.startsWith(projectDir + sep) || !existsSync(original) || HANDOVER_SOURCE_FILES.includes(reference)) continue;
      mkdirSync(dirname(resolve(root, reference)), { recursive: true });
      writeFileSync(resolve(root, reference), 'Complete-project reference fixture. Not included in the legacy pack.\n');
    }
  }
  return root;
}

test('handover contains ten disconnected sponsors and a genuine saved local case awaiting approval', async t => {
  const outputDir = resolve(temp(t), 'pack');
  const { manifest } = await prepareSponsorHandover({ projectDir, outputDir });
  const packagedProvider = await import(pathToFileURL(resolve(outputDir, 'server/providers.mjs')).href);
  assert.equal(typeof packagedProvider.createProviders, 'function', 'packaged adapter must resolve its own local dependencies');
  assert.deepEqual(manifest.sponsors.map(x => x.id).sort(), ['anthropic','elevenlabs','miro','modal','n8n','openai','port','stripe','supabase','vercel']);
  assert.equal(manifest.mode, 'offline');
  assert.equal(manifest.standaloneApplication, false);
  assert.equal(manifest.containsRuntimeDatabase, false);
  assert.equal(manifest.scope, 'legacy-small-pack');
  assert.equal(manifest.completeCurrentApplicationIncluded, false);
  assert.equal(manifest.configuration.REFUND_OFFICE_CHALLENGER, 'none');
  for (const path of ['.env.example', 'integrations/.env.example']) assert.match(readFileSync(resolve(outputDir, path), 'utf8'), /^REFUND_OFFICE_CHALLENGER=none$/m);
  assert.ok(manifest.sponsors.every(x => x.connected === false && x.liveVerified === false && ['prepared', 'local-verified'].includes(x.status) && x.blockers.length));
  assert.ok(manifest.sponsors.every(x => x.verificationScope.startsWith('This legacy small pack:')));
  assert.match(manifest.sponsors.find(x => x.id === 'elevenlabs').blockers.join(' '), /This legacy small pack contains no audio or exposed speech-generation route.*separate complete current application contains the gated saved-briefing route/);
  assert.doesNotMatch(JSON.stringify(manifest.sponsors), /current UI still uses SQLite|application integration and payment execution remain incomplete|the app has no exposed speech/);
  assert.match(readFileSync(resolve(outputDir, 'README.md'), 'utf8'), /readiness statements below describe only files included in this legacy pack/);
  for (const entry of manifest.files) {
    const bytes = readFileSync(resolve(outputDir, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
  }
  for (const sponsor of manifest.sponsors) for (const path of sponsor.files) assert.ok(existsSync(resolve(outputDir, path)), path);
  const packet = read(outputDir, 'examples/saved-case.json');
  assert.equal(packet.dataMode, 'synthetic-orders');
  assert.equal(packet.case.outcome, 'awaiting-approval');
  assert.equal(packet.case.approval.state, 'required');
  assert.equal(packet.case.receipt, null);
  assert.equal(packet.operation, null);
  assert.equal(packet.capabilities.networkMode, 'offline');
  assert.match(readFileSync(resolve(outputDir, 'examples/decision-report.md'), 'utf8'), /has not been granted/);
  assert.ok(manifest.totalContentBytes < 1024 * 1024);
});

test('request examples match the adapters and never claim remote identities or generated speech', async t => {
  const outputDir = resolve(temp(t), 'pack');
  await prepareSponsorHandover({ projectDir, outputDir });
  const openai = read(outputDir, 'examples/openai/request.json');
  const anthropic = read(outputDir, 'examples/anthropic/request.json');
  assert.equal(openai.url, 'https://api.openai.com/v1/responses');
  assert.equal(openai.body.store, false);
  assert.equal(openai.body.text.format.strict, true);
  assert.equal(openai.body.model, 'SELECT_AVAILABLE_MODEL');
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.body.output_config.format.type, 'json_schema');
  assert.deepEqual(JSON.parse(openai.body.input[0].content), JSON.parse(anthropic.body.messages[0].content));
  assert.equal(openai.sent, false);
  assert.equal(anthropic.sent, false);
  const voice = read(outputDir, 'examples/elevenlabs/request.json');
  assert.equal(voice.voiceId, null);
  assert.equal(voice.audioGenerated, false);
  assert.match(voice.url, /\{ELEVENLABS_VOICE_ID\}/);
  assert.equal(voice.body.text + '\n', readFileSync(resolve(outputDir, 'examples/elevenlabs/briefing.txt'), 'utf8'));
  const miro = read(outputDir, 'examples/miro/note-requests.json');
  assert.equal(miro.boardId, null);
  assert.ok(miro.requests.length > 0);
  assert.ok(miro.requests.every(x => !x.id && /\{MIRO_BOARD_ID\}/.test(x.url)));
  const stripe = read(outputDir, 'examples/stripe/scenario.json');
  assert.equal(stripe.approved, false);
  assert.equal(stripe.humanApprovalRequired, true);
  assert.equal(stripe.amountMinor, 2000);
  assert.equal(stripe.currency, 'gbp');
  assert.ok(!('paymentIntentId' in stripe) && !('receipt' in stripe) && !('idempotencyKey' in stripe));
});

test('staging copies preserve validated data and local extraction matches the packaged Python function', async t => {
  const outputDir = resolve(temp(t), 'pack');
  const { manifest } = await prepareSponsorHandover({ projectDir, outputDir });
  assert.deepEqual(manifest.datasets.map(x => [x.id, x.cases, x.orders, x.historicalLocalFixtures]), [['focused-12',12,11,1],['busy-50',50,46,4]]);
  for (const id of ['focused-12','busy-50']) {
    assert.deepEqual(readFileSync(resolve(outputDir, `staging/${id}.json`)), readFileSync(resolve(projectDir, `demo-data/${id}.json`)));
    assert.ok(read(outputDir, `staging/${id}.json`).seedOperations.every(x => x.receipt.seeded));
  }
  assert.equal(read(outputDir, 'integrations/n8n/refund-intake.workflow.json').active, false);
  const input = readFileSync(resolve(outputDir, 'examples/modal/input.json'), 'utf8');
  const result = spawnSync('python3', ['-B', '-c', 'import json,sys;from extract import extract_document;print(json.dumps(extract_document(json.load(sys.stdin))))'], {
    cwd: resolve(outputDir, 'integrations/modal'), input, encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), read(outputDir, 'examples/modal/expected-output.json'));
});

test('allowlist excludes poisoned private files and ambient credentials cannot cause a request', async t => {
  const source = sourceCopy(t);
  const poison = 'PRIVATE-CONTENT-MUST-NOT-BE-COPIED';
  for (const path of ['.env', '.data/refund-office.sqlite', 'work/session.log', 'videos/private.mp4', 'node_modules/private.js', 'integrations/credentials.json']) {
    mkdirSync(dirname(resolve(source, path)), { recursive: true }); writeFileSync(resolve(source, path), poison);
  }
  const priorFetch = globalThis.fetch;
  const keys = ['REFUND_OFFICE_NETWORK', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'STRIPE_SECRET_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let calls = 0;
  try {
    globalThis.fetch = () => { calls++; throw new Error('unexpected real transport'); };
    keys.forEach(key => { process.env[key] = key === 'REFUND_OFFICE_NETWORK' ? 'enabled' : poison; });
    const outputDir = resolve(source, 'handover');
    const { manifest } = await prepareSponsorHandover({ projectDir: source, outputDir });
    assert.equal(calls, 0);
    for (const entry of manifest.files) {
      assert.ok(!entry.path.startsWith('.data/') && !entry.path.startsWith('work/') && !entry.path.startsWith('node_modules/'));
      assert.ok(!readFileSync(resolve(outputDir, entry.path), 'utf8').includes(poison));
    }
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('filled configuration templates are refused before any handover is written', async t => {
  const source = sourceCopy(t);
  const original = readFileSync(resolve(source, '.env.example'), 'utf8');
  for (const [before, after] of [['OPENAI_API_KEY=', 'OPENAI_API_KEY=fake-private-key'], ['REFUND_OFFICE_CHALLENGER=none', 'REFUND_OFFICE_CHALLENGER=openai']]) {
    writeFileSync(resolve(source, '.env.example'), original.replace(before, after));
    await assert.rejects(prepareSponsorHandover({ projectDir: source }), /nonblank private or unsafe value/);
    assert.equal(existsSync(resolve(source, 'handover')), false);
  }
  writeFileSync(resolve(source, '.env.example'), original.replace('REFUND_OFFICE_CHALLENGER=none', ''));
  await assert.rejects(prepareSponsorHandover({ projectDir: source }), /local offline defaults/);
});

test('source symbolic links and oversized source inputs are refused', async t => {
  const source = sourceCopy(t);
  const path = resolve(source, 'integrations/port/service.example.json');
  rmSync(path); symlinkSync(resolve(projectDir, 'integrations/port/service.example.json'), path);
  await assert.rejects(prepareSponsorHandover({ projectDir: source }), /Symbolic links/);
  rmSync(path); writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(prepareSponsorHandover({ projectDir: source }), /one MiB/);
});

test('regeneration preserves user changes and refuses extra files or destination links', async t => {
  const base = temp(t), outputDir = resolve(base, 'pack');
  const first = await prepareSponsorHandover({ projectDir, outputDir });
  const second = await prepareSponsorHandover({ projectDir, outputDir });
  assert.equal(first.manifest.files.length, second.manifest.files.length);
  const path = resolve(outputDir, 'examples/decision-report.md');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original + '\nPersonal review note.\n');
  await assert.rejects(prepareSponsorHandover({ projectDir, outputDir }), /changed handover file/);
  assert.match(readFileSync(path, 'utf8'), /Personal review note/);
  writeFileSync(path, original);
  writeFileSync(resolve(outputDir, 'personal.txt'), 'Do not overwrite.');
  await assert.rejects(prepareSponsorHandover({ projectDir, outputDir }), /extra or missing files/);
  const alias = resolve(base, 'alias'); symlinkSync(outputDir, alias);
  await assert.rejects(prepareSponsorHandover({ projectDir, outputDir: resolve(alias, 'nested') }), /Symbolic links/);
  assert.equal(existsSync(resolve(outputDir, 'nested')), false);
});

test('all local documentation links in the pack resolve without referring outside it', async t => {
  const outputDir = resolve(temp(t), 'pack');
  const { manifest } = await prepareSponsorHandover({ projectDir, outputDir });
  for (const entry of manifest.files.filter(x => x.path.endsWith('.md'))) {
    const content = readFileSync(resolve(outputDir, entry.path), 'utf8');
    if (entry.sourceSha256) {
      assert.equal(entry.sourceSha256, digest(readFileSync(resolve(projectDir, entry.source))));
      assert.notEqual(entry.sourceSha256, entry.sha256);
      assert.match(entry.adaptation, /separate complete-current-application references/);
    }
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|#)/.test(target)) continue;
      const path = resolve(outputDir, dirname(entry.path), target.split('#')[0]);
      assert.ok(path.startsWith(outputDir + '/'), `${entry.path}: outside link ${target}`);
      assert.ok(existsSync(path), `${entry.path}: missing link ${target}`);
    }
  }
  const setup = readFileSync(resolve(outputDir, 'integrations/SETUP.md'), 'utf8');
  assert.match(setup, /`docs\/HOSTED-SETUP\.md`, available in the separate complete current application; not included in this legacy small pack/);
  assert.ok(!manifest.files.some(entry => entry.path === 'docs/HOSTED-SETUP.md' || entry.path === 'server/sponsor-actions.mjs'));
  const source = sourceCopy(t), doc = resolve(source, 'docs/integrations.md');
  writeFileSync(doc, readFileSync(doc, 'utf8') + '\n[Unknown reference](not-a-project-file.md)\n');
  await assert.rejects(prepareSponsorHandover({ projectDir: source }), /unknown complete-project file/);
  assert.equal(existsSync(resolve(source, 'handover')), false);
});
