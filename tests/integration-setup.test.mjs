import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import offlineApi from '../integrations/vercel/api/offline.mjs';

const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const json = file => JSON.parse(read(file));

test('the integration template has no credentials and starts with every connection disabled', () => {
  const entries = Object.fromEntries(read('integrations/.env.example').split('\n').filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(entries.REFUND_OFFICE_NETWORK, 'offline');
  assert.equal(entries.REFUND_OFFICE_ENABLED_INTEGRATIONS, '');
  assert.equal(entries.REFUND_OFFICE_ANALYSER, 'local');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'STRIPE_SECRET_KEY', 'N8N_INTAKE_TOKEN', 'SUPABASE_PUBLISHABLE_KEY', 'MIRO_ACCESS_TOKEN', 'MODAL_EVIDENCE_TOKEN', 'PORT_ACCESS_TOKEN', 'VERCEL_PROJECT_ID']) assert.equal(entries[key], '', key);
  assert.equal(Object.keys(entries).some(key => key.startsWith('VITE_')), false);
});

test('the prepared n8n workflow is inactive, authenticated, local and intake-only', () => {
  const workflow = json('integrations/n8n/refund-intake.workflow.json');
  assert.equal(workflow.active, false);
  assert.equal(workflow.nodes.length, 4);
  assert.equal(workflow.nodes.some(node => node.credentials), false);
  const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.parameters.httpMethod, 'POST');
  const calls = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parameters.url, 'http://127.0.0.1:4174/api/intake');
  assert.equal(calls[0].parameters.method, 'POST');
  assert.equal(calls[0].retryOnFail, undefined);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  const response = workflow.nodes.find(node => node.type === 'n8n-nodes-base.respondToWebhook');
  assert.match(response.parameters.responseBody, /accepted: true, eventId: \$json\.request\.eventId/);
  for (const name of ['approve', 'advance', 'reconcile', 'refunds']) assert.equal(calls.some(node => node.parameters.url.includes('/' + name)), false);
});

test('n8n validation preserves a stable event and ignores attempted action/approval fields', () => {
  const workflow = json('integrations/n8n/refund-intake.workflow.json');
  const code = workflow.nodes.find(node => node.type === 'n8n-nodes-base.code').parameters.jsCode;
  const validate = new Function('$input', code);
  const input = body => ({ first: () => ({ json: { body } }) });
  const valid = { eventId: 'request-104', orderId: 'DEMO-104', complaint: ' One mug is missing. ', action: 'approve', amountMinor: 5000 };
  assert.deepEqual(validate(input(valid)), [{ json: { eventId: 'request-104', orderId: 'DEMO-104', complaint: 'One mug is missing.' } }]);
  for (const body of [null, [], {}, { ...valid, eventId: '' }, { ...valid, orderId: '../private' }, { ...valid, complaint: 'short' }, { ...valid, complaint: 'a'.repeat(4001) }]) assert.throws(() => validate(input(body)));
});

test('Supabase migration statically declares owner isolation and immutable idempotent RPC writes', () => {
  const sql = read('integrations/supabase/001_decision_packet_archive.sql');
  assert.match(sql, /primary key \(owner_id, case_id, revision\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.refund_decision_packets from public, anon, authenticated/i);
  assert.match(sql, /for select to authenticated using \(owner_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(sql, /before update or delete on public\.refund_decision_packets/i);
  assert.match(sql, /security definer set search_path = ''/i);
  assert.match(sql, /reviewer uuid := auth\.uid\(\)/i);
  assert.match(sql, /if reviewer is null/i);
  assert.match(sql, /on conflict \(owner_id, case_id, revision\) do nothing/i);
  assert.match(sql, /saved\.packet is distinct from p_packet/i);
  assert.match(sql, /p_packet #>> '\{case,id\}' is distinct from p_case_id/i);
  assert.match(sql, /p_packet #> '\{case,revision\}' is distinct from pg_catalog\.to_jsonb\(p_revision\)/i);
  assert.match(sql, /grant execute on function public\.archive_refund_decision\(text, bigint, jsonb\) to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:all|insert|update|delete).*to (?:anon|authenticated)/i);
});

test('Port and Miro setup contains readiness metadata without a fabricated connection', () => {
  const blueprint = json('integrations/port/blueprint.json');
  assert.equal(blueprint.identifier, 'refund-office-service');
  assert.deepEqual(blueprint.schema.properties.readiness.enum, ['offline', 'prepared', 'configured-unverified']);
  assert.deepEqual(blueprint.schema.properties.humanApprovalRequired.enum, [true]);
  assert.deepEqual(blueprint.schema.properties.liveVerified.enum, [false]);
  assert.deepEqual(Object.keys(json('integrations/port/service.example.json')).sort(), ['identifier', 'status', 'title']);
  const miro = json('integrations/miro/config.example.json');
  assert.equal(miro.boardId, '');
  assert.equal(miro.importReady, false);
  assert.equal(miro.publishEnabled, false);
});

test('the prepared Vercel boundary rejects every API method without any network call', () => {
  const config = json('integrations/vercel/vercel.json');
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'dist/client');
  assert.deepEqual(config.rewrites.slice(0, 2), [{ source: '/api', destination: '/api/offline' }, { source: '/api/:path*', destination: '/api/offline' }]);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = { headers: {} };
    const response = { setHeader: (name, value) => { result.headers[name] = value; }, status: code => { result.status = code; return response; }, json: body => { result.body = body; } };
    offlineApi({ method, url: '/api/cases/x/approve' }, response);
    assert.equal(result.status, 503);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.error.code, 'hosted_api_not_available');
  }
});

test('the pure Modal extractor passes its local Python boundary tests without packages', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'integrations/modal', '-p', 'test_extract.py', '-v'], {
    cwd: fileURLToPath(root), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});

test('Modal deployment import is blocked before the Modal package is loaded when offline', () => {
  const result = spawnSync('python3', ['-c', 'import runpy; runpy.run_path("integrations/modal/modal_app.py")'], {
    cwd: fileURLToPath(root), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ENABLED_INTEGRATIONS: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Modal deployment is disabled/);
  assert.doesNotMatch(result.stderr, /ModuleNotFoundError/);
});
