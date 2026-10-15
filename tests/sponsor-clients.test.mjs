import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSponsorClients, IntegrationError, planMiroNotes } from '../server/sponsor-clients.mjs';

const configured = {
  REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'n8n,supabase,miro,modal,port',
  N8N_INTAKE_WEBHOOK_URL: 'https://workflow.example.test/webhook/refunds', N8N_INTAKE_TOKEN: 'fake-n8n-token',
  SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'fake-publishable',
  MIRO_ACCESS_TOKEN: 'fake-miro-token', MODAL_EVIDENCE_URL: 'https://example--extract.modal.run/', MODAL_EVIDENCE_TOKEN: 'fake-modal-token',
  PORT_API_URL: 'https://api.port.io', PORT_BLUEPRINT_ID: 'refund_service', PORT_ACCESS_TOKEN: 'fake-port-token',
};
const input = { eventId: 'support:001', orderId: 'DEMO-104', complaint: 'The travel mug is missing.' };
const packet = { case: { id: 'missing-item', revision: 4 }, evidence: [] };
const board = { format: 'refund-office-case-board', caseId: 'RF-104', revision: 4, columns: [{ id: 'evidence', title: 'Evidence', cards: [{ id: 'packing', title: 'Packing', text: '<img src=x onerror=bad()> & notes' }] }] };
const document = { id: 'packing-104', text: 'Two of three items packed.\nTravel mug missing.' };
const extraction = { documentId: document.id, sha256: createHash('sha256').update(document.text).digest('hex'), lines: document.text.split('\n').map((text, index) => ({ line: index + 1, text })), authoritative: false };
const service = { identifier: 'refund-office', title: 'Refund Office', status: 'prepared' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const errorCode = (code, uncertain) => error => error instanceof IntegrationError && error.code === code && (uncertain === undefined || error.uncertain === uncertain);

test('every sponsor client refuses calls unless both global and individual opt-ins are present', async () => {
  for (const overrides of [{ REFUND_OFFICE_NETWORK: 'offline' }, { REFUND_OFFICE_NETWORK: '' }, { REFUND_OFFICE_ENABLED_INTEGRATIONS: '' }]) {
    let calls = 0;
    const clients = createSponsorClients({ env: { ...configured, ...overrides }, fetchImpl: () => { calls++; assert.fail('Unexpected network call'); } });
    const requests = [() => clients.sendN8nIntake(input), () => clients.getSupabaseReviewer('fake-user-token'), () => clients.archiveSupabasePacket(packet, 'fake-user-token'), () => clients.createMiroNote('uXjVabc=', planMiroNotes(board)[0]), () => clients.extractWithModal(document), () => clients.upsertPortService(service)];
    for (const request of requests) await assert.rejects(request, errorCode('integration_disconnected', false));
    assert.equal(calls, 0);
    assert.deepEqual(clients.status().enabled, []);
  }
});

test('n8n acknowledgement preserves event identity, sends only intake data and cannot claim payment success', async () => {
  const calls = [];
  const clients = createSponsorClients({ env: configured, fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ accepted: true, eventId: input.eventId }); } });
  const result = await clients.sendN8nIntake({ ...input, approve: true, amount: 999 });
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].options.body), input);
  assert.equal(calls[0].options.headers['X-Refund-Intake-Token'], configured.N8N_INTAKE_TOKEN);
  assert.equal(calls[0].options.redirect, 'error'); assert.ok(calls[0].options.signal);
  assert.equal(result.eventId, input.eventId); assert.match(result.scope, /not an investigation or refund result/);
});

test('a mismatched n8n acknowledgement is uncertain, never retried or converted to success', async () => {
  let calls = 0;
  const clients = createSponsorClients({ env: configured, fetchImpl: async () => { calls++; return json({ accepted: true, eventId: 'another-event' }); } });
  await assert.rejects(() => clients.sendN8nIntake(input), errorCode('invalid_acknowledgement', true));
  assert.equal(calls, 1);
});

test('Supabase archive checks the signed-in reviewer and verifies returned ownership and case revision', async () => {
  const calls = [];
  const clients = createSponsorClients({ env: configured, fetchImpl: async (url, options) => { calls.push({ url, options }); return json(url.endsWith('/auth/v1/user') ? { id: 'user-123' } : { owner_id: 'user-123', case_id: packet.case.id, revision: packet.case.revision }); } });
  const result = await clients.archiveSupabasePacket(packet, 'fake-user-token');
  assert.equal(result.owner_id, 'user-123'); assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/auth/v1/user'));
  assert.ok(calls[1].url.endsWith('/rest/v1/rpc/archive_refund_decision'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_case_id: packet.case.id, p_revision: 4, p_packet: packet });
  for (const { options } of calls) { assert.equal(options.headers.apikey, configured.SUPABASE_PUBLISHABLE_KEY); assert.equal(options.headers.Authorization, 'Bearer fake-user-token'); }
  const wrongOwner = createSponsorClients({ env: configured, fetchImpl: async url => json(url.endsWith('/auth/v1/user') ? { id: 'user-123' } : { owner_id: 'user-other', case_id: packet.case.id, revision: 4 }) });
  await assert.rejects(() => wrongOwner.archiveSupabasePacket(packet, 'fake-user-token'), errorCode('archive_mismatch', true));
});

test('Miro plan escapes complaint markup and preserves stable local note identities', async () => {
  const notes = planMiroNotes(board);
  assert.deepEqual(planMiroNotes(structuredClone(board)), notes);
  assert.doesNotMatch(notes[0].body.data.content, /<img/); assert.match(notes[0].body.data.content, /&lt;img/);
  let posted;
  const clients = createSponsorClients({ env: configured, fetchImpl: async (url, options) => { posted = { url, options }; return json({ id: 'item-123' }); } });
  const receipt = await clients.createMiroNote('uXjVabc=', notes[0]);
  assert.equal(receipt.localId, notes[0].localId); assert.equal(receipt.boardId, 'uXjVabc=');
  assert.match(posted.url, /uXjVabc%3D\/sticky_notes$/); assert.deepEqual(JSON.parse(posted.options.body), notes[0].body);
});

test('Modal extraction must match the submitted document digest and remain non-authoritative', async () => {
  const clients = createSponsorClients({ env: configured, fetchImpl: async (url, options) => { assert.deepEqual(JSON.parse(options.body), document); return json(extraction); } });
  assert.deepEqual(await clients.extractWithModal(document), extraction);
  for (const changed of [{ sha256: 'wrong' }, { authoritative: true }, { lines: [null] }, { lines: [{ line: 99, text: 'Invented evidence' }] }, { lines: [{ line: 1, text: 'Changed text' }, extraction.lines[1]] }, { lines: [...extraction.lines].reverse() }]) {
    const invalid = createSponsorClients({ env: configured, fetchImpl: async () => json({ ...extraction, ...changed }) });
    await assert.rejects(() => invalid.extractWithModal(document), errorCode('extraction_mismatch', true));
  }
});

test('Port publishes only catalogue metadata with human approval and unverified status', async () => {
  let posted;
  const clients = createSponsorClients({ env: configured, fetchImpl: async (url, options) => { posted = { url, options }; return json({ entity: { identifier: service.identifier } }); } });
  const result = await clients.upsertPortService(service);
  assert.equal(result.identifier, service.identifier); assert.match(result.scope, /no deployment or refund permission/);
  assert.equal(posted.url, 'https://api.port.io/v1/blueprints/refund_service/entities?upsert=true&merge=true');
  assert.deepEqual(JSON.parse(posted.options.body).properties, { readiness: 'prepared', humanApprovalRequired: true, liveVerified: false });
  await assert.rejects(() => clients.upsertPortService({ ...service, status: 'live' }), errorCode('invalid_catalog_entry'));
});

test('endpoint validation rejects credential-bearing, insecure and unsupported service origins before I/O', async () => {
  for (const bad of ['http://workflow.example.test/x', 'https://token@workflow.example.test/x', 'https://127.0.0.1/x', 'https://workflow.example.test/x?token=secret']) {
    const clients = createSponsorClients({ env: { ...configured, N8N_INTAKE_WEBHOOK_URL: bad }, fetchImpl: () => assert.fail('Network call') });
    await assert.rejects(() => clients.sendN8nIntake(input), errorCode('invalid_endpoint'));
  }
  const clients = createSponsorClients({ env: { ...configured, PORT_API_URL: 'https://fake.api.port.io' }, fetchImpl: () => assert.fail('Network call') });
  await assert.rejects(() => clients.upsertPortService(service), errorCode('invalid_endpoint'));
});

test('network errors and unreadable write responses preserve uncertainty without leaking secrets or retrying', async () => {
  const cases = [
    { fetch: () => { throw new Error('secret-fake-token'); }, code: 'connection_unconfirmed' },
    { fetch: () => new Response('secret-fake-token', { status: 503 }), code: 'provider_rejected' },
    { fetch: () => new Response('<html>secret-fake-token</html>'), code: 'invalid_response' },
    { fetch: () => new Response('bad-json', { headers: { 'Content-Type': 'application/json' } }), code: 'invalid_response' },
    { fetch: () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }), code: 'response_too_large' },
  ];
  for (const scenario of cases) {
    let calls = 0;
    const clients = createSponsorClients({ env: configured, fetchImpl: async () => { calls++; return scenario.fetch(); } });
    await assert.rejects(() => clients.sendN8nIntake(input), error => { assert.doesNotMatch(error.message, /secret-fake-token/); return errorCode(scenario.code, true)(error); });
    assert.equal(calls, 1);
  }
});
