import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from '../server/providers.mjs';
import { createElevenLabs } from '../server/elevenlabs.mjs';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { validateDemoDataset } from '../server/demo-dataset.mjs';
import { buildBriefing, buildDecisionReport, buildMiroExport } from '../server/integration-prep.mjs';
import { planMiroNotes } from '../server/sponsor-clients.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 5 * 1024 * 1024;
const KIND = 'refund-office-offline-sponsor-handover';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };

// No directory globbing: adding a file to the project never adds it to a pack.
export const HANDOVER_SOURCE_FILES = Object.freeze([
  '.env.example', 'docs/ONLINE-SETUP.md', 'docs/SUPABASE-MIGRATION.md', 'docs/integrations.md',
  'integrations/SETUP.md', 'integrations/.env.example',
  'integrations/n8n/refund-intake.workflow.json',
  'integrations/supabase/001_decision_packet_archive.sql',
  'integrations/vercel/vercel.json', 'integrations/vercel/api/offline.mjs',
  'integrations/miro/config.example.json',
  'integrations/modal/extract.py', 'integrations/modal/modal_app.py', 'integrations/modal/test_extract.py',
  'integrations/port/blueprint.json', 'integrations/port/service.example.json',
  'server/providers.mjs', 'server/claim-language.mjs', 'server/elevenlabs.mjs', 'server/integration-prep.mjs', 'server/case-provenance.mjs',
  'server/sponsor-clients.mjs', 'server/intake.mjs', 'server/engine.mjs',
  'server/store.mjs', 'server/fixtures.mjs', 'server/demo-dataset.mjs',
  'demo-data/README.md', 'demo-data/SCENARIOS.md', 'demo-data/expected-outcomes.csv',
  'demo-data/focused-12.json', 'demo-data/busy-50.json',
  'demo-data/n8n-intake.focused-12.json', 'demo-data/n8n-intake.busy-50.json',
]);

function validPath(path) {
  return typeof path === 'string' && path.length < 240 && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..') && !path.startsWith('/');
}
function checkedFile(root, path) {
  if (!validPath(path)) fail('A handover path is invalid.');
  let current = root;
  if (lstatSync(current).isSymbolicLink()) fail('Symbolic links are not permitted in handover sources.');
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('Symbolic links are not permitted in handover sources.');
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('Handover inputs must be regular files no larger than one MiB.');
  return current;
}
function validateTemplate(text) {
  const settings = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || settings.has(match[1])) fail('The environment template must contain unique plain assignments.');
    settings.set(match[1], match[2]);
  }
  const safe = { REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_CHALLENGER: 'none', REFUND_OFFICE_ENABLED_INTEGRATIONS: '',
    DB_PATH: '.data/refund-office.sqlite', API_PORT: '4174', PORT_BLUEPRINT_ID: 'refund-office-service' };
  for (const [key, value] of settings) if (value && value !== safe[key]) fail('A handover environment template contains a nonblank private or unsafe value.');
  for (const key of ['REFUND_OFFICE_NETWORK', 'REFUND_OFFICE_ANALYSER', 'REFUND_OFFICE_CHALLENGER', 'REFUND_OFFICE_ENABLED_INTEGRATIONS']) {
    if (settings.get(key) !== safe[key]) fail('Environment templates must keep the local offline defaults.');
  }
}
function adaptDocumentation(text, source, projectDir) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return match;
    const path = relative(projectDir, resolve(projectDir, dirname(source), target.split('#')[0])).split(sep).join('/');
    if (HANDOVER_SOURCE_FILES.includes(path)) return match;
    if (!validPath(path) || !existsSync(resolve(projectDir, path))) fail(`A handover document refers to an unknown complete-project file: ${source}`);
    checkedFile(projectDir, path); // Check existence and type only; never read or copy the referenced file.
    return `${label} (\`${path}\`, available in the separate complete current application; not included in this legacy small pack)`;
  });
}
function outputInventory(root, prefix = '') {
  const result = [];
  for (const entry of readdirSync(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('The existing handover contains a symbolic link.');
    if (entry.isDirectory()) result.push(...outputInventory(root, path));
    else if (entry.isFile()) result.push(path);
    else fail('The existing handover contains an unsupported file type.');
  }
  return result.sort();
}
function checkExisting(outputDir, nextPaths) {
  for (let path = outputDir; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('Symbolic links are not permitted in the handover destination.');
    if (dirname(path) === path) break;
  }
  if (!existsSync(outputDir)) return;
  if (lstatSync(outputDir).isSymbolicLink() || !lstatSync(outputDir).isDirectory()) fail('The handover destination must be a real directory.');
  const inventory = outputInventory(outputDir);
  if (!inventory.length) return;
  if (!inventory.includes('manifest.json')) fail('Refusing to overwrite a handover without its generated manifest.');
  const prior = JSON.parse(readFileSync(checkedFile(outputDir, 'manifest.json'), 'utf8'));
  if (prior.kind !== KIND || prior.schemaVersion !== 1 || !Array.isArray(prior.files) || prior.files.length > 100) fail('The existing handover manifest is not recognised.');
  const paths = prior.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || paths.some(path => !validPath(path) || !nextPaths.includes(path))) fail('The existing handover has unexpected paths.');
  if (JSON.stringify(inventory) !== JSON.stringify([...paths, 'manifest.json'].sort())) fail('The existing handover contains extra or missing files; keep personal changes elsewhere.');
  for (const file of prior.files) {
    const bytes = readFileSync(checkedFile(outputDir, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail(`Refusing to overwrite a changed handover file: ${file.path}`);
  }
}

async function savedExample(dataset) {
  const store = createStore({ dbPath: ':memory:', dataset });
  try {
    const provider = createProviders({ env: {}, fetchImpl: () => fail('Handover preparation attempted a network request.') });
    const engine = createEngine({ store, provider });
    let item = await engine.run(dataset.cases[0].id);
    for (let i = 0; item.status === 'running' && i < 12; i++) item = await engine.advance(item.id, { expectedRevision: item.revision });
    if (item.outcome !== 'awaiting-approval' || item.approval?.state !== 'required' || item.receipt || item.operationId) fail('The saved handover example must stop before approval or payment.');
    return engine.exportCase(item.id);
  } finally { store.close(); }
}

async function modelExample(name, input, proposal) {
  let request;
  const mockReply = name === 'openai'
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposal) }] };
  const provider = createProviders({
    env: { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: name,
      [`${name.toUpperCase()}_API_KEY`]: 'handover-injected-transport-only', [`${name.toUpperCase()}_MODEL`]: 'SELECT_AVAILABLE_MODEL' },
    fetchImpl: async (url, options) => {
      if (request) fail('Expected one injected model request.');
      request = { url, method: options.method, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(mockReply), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await provider.proposeCase(input);
  if (result.amountMinor !== proposal.amountMinor || result.source !== name) fail('The model request example failed its injected response check.');
  return { kind: 'unsent-request-template', synthetic: true, sent: false, liveVerified: false,
    notice: 'Captured from the adapter using an injected response. Select an available model later. This is not an AI-generated proposal or a completed provider request.',
    ...request, headers: name === 'openai' ? { Authorization: 'Bearer ${OPENAI_API_KEY}', 'Content-Type': 'application/json' }
      : { 'x-api-key': '${ANTHROPIC_API_KEY}', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } };
}

async function voiceExample(text) {
  let request;
  const voice = createElevenLabs({ env: { REFUND_OFFICE_NETWORK: 'enabled', ELEVENLABS_API_KEY: 'handover-injected-transport-only', ELEVENLABS_VOICE_ID: 'UNSELECTED_VOICE' },
    fetchImpl: async (url, options) => {
      request = { url: url.replace('UNSELECTED_VOICE', '{ELEVENLABS_VOICE_ID}'), method: options.method, body: JSON.parse(options.body) };
      const header = Buffer.alloc(32); header.write('ID3'); header[3] = 4;
      return new Response(header, { headers: { 'Content-Type': 'audio/mpeg' } });
    } });
  await voice.synthesise({ text }); // Header-only fake response is discarded; no speech or audio file is generated.
  return { kind: 'unsent-request-template', sent: false, audioGenerated: false, liveVerified: false, voiceId: null,
    notice: 'Choose and confirm an available approved voice before any later call. The local mock checks transport only; its bytes are discarded.',
    ...request, headers: { 'xi-api-key': '${ELEVENLABS_API_KEY}', 'Content-Type': 'application/json', Accept: 'audio/mpeg' } };
}

function readiness() {
  const entries = [
    ['openai', 'OpenAI', 'local-verified', 'Structured proposal request captured through an injected response.', ['Account access, selected available model and credits are unverified.', 'No remote proposal has been requested.'], ['examples/openai/request.json', 'server/providers.mjs']],
    ['anthropic', 'Anthropic', 'local-verified', 'Advisory proposal request captured through an injected response.', ['Account access, selected available model and credits are unverified.', 'The included request cannot approve; the separate complete current application also contains an advisory comparison service.'], ['examples/anthropic/request.json', 'server/providers.mjs']],
    ['elevenlabs', 'ElevenLabs', 'local-verified', 'Request captured with a discarded header-only mock response; saved text is local.', ['An approved available voice, account access and credits are required.', 'This legacy small pack contains no audio or exposed speech-generation route. The separate complete current application contains the gated saved-briefing route.'], ['examples/elevenlabs/request.json', 'examples/elevenlabs/briefing.txt', 'server/elevenlabs.mjs']],
    ['n8n', 'n8n', 'prepared', 'Inactive intake-only workflow and validated synthetic event examples.', ['Import, header credential binding and execution are unverified.', 'The included loopback workflow needs local n8n reachability; protected hosted intake is prepared in the separate complete current application.'], ['integrations/n8n/refund-intake.workflow.json', 'demo-data/n8n-intake.focused-12.json', 'demo-data/n8n-intake.busy-50.json']],
    ['supabase', 'Supabase', 'prepared', 'Private archive SQL and working-database migration guide; operational runtime preparation is supplied separately.', ['This archive schema and deployed Supabase permissions remain unverified.', 'This legacy small pack excludes the operational UI, authenticated API and payment executor; prepared implementations are in the separate complete current application.'], ['integrations/supabase/001_decision_packet_archive.sql', 'docs/SUPABASE-MIGRATION.md', 'examples/saved-case.json', 'staging/focused-12.json', 'staging/busy-50.json']],
    ['vercel', 'Vercel', 'prepared', 'Frontend configuration deliberately routes API requests to an unavailable handler.', ['Not deployed by this generator. All API methods return 503 in the included scaffold.', 'The separate complete current application contains a prepared hosted backend; its online setup and acceptance remain unverified.'], ['integrations/vercel/vercel.json', 'integrations/vercel/api/offline.mjs']],
    ['miro', 'Miro', 'local-verified', 'Board outline and sticky-note bodies produced by pure local functions.', ['No board is selected or published by this generator.', 'The action facade and persistent ledger are in the separate complete current application; actual provider readback remains unverified.'], ['examples/miro/case-board.json', 'examples/miro/note-requests.json', 'integrations/miro/config.example.json']],
    ['modal', 'Modal', 'prepared', 'Pure extractor source, synthetic input and calculated expected output.', ['Cloud deployment, dependency installation, secret binding and endpoint access are unverified.', 'The generated expected output is a local fixture, not a Modal run.'], ['integrations/modal/extract.py', 'integrations/modal/modal_app.py', 'examples/modal/input.json', 'examples/modal/expected-output.json']],
    ['stripe', 'Stripe', 'prepared', 'Test-only adapter and unapproved synthetic order/amount scenario.', ['No test account or remote PaymentIntent/refund identity exists.', 'Explicit human approval, test mode and independent readback are mandatory before a later test submission.'], ['examples/stripe/scenario.json', 'server/providers.mjs']],
    ['port', 'Port', 'prepared', 'Readiness blueprint and metadata request, with no deployment authority.', ['Blueprint import, regional endpoint and access are unverified.', 'Catalogue write acknowledgement must be independently retrieved later.'], ['integrations/port/blueprint.json', 'integrations/port/service.example.json', 'examples/port/entity-request.json']],
  ];
  return entries.map(([id, name, status, verificationScope, blockers, files]) => ({ id, name, status, connected: false, liveVerified: false, verificationScope: `This legacy small pack: ${verificationScope}`, blockers, files }));
}

export async function prepareSponsorHandover({ projectDir = projectRoot, outputDir = resolve(projectDir, 'handover') } = {}) {
  projectDir = resolve(projectDir); outputDir = resolve(outputDir);
  const between = relative(outputDir, projectDir);
  if (!between || (!between.startsWith('..' + sep) && between !== '..' && !between.startsWith(sep))) fail('The handover destination cannot contain the source project.');
  const files = new Map();
  const add = (path, value, source = 'generated') => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!validPath(path) || bytes.length > MAX_FILE_BYTES || files.has(path)) fail('Invalid or duplicate handover output.');
    files.set(path, { bytes, source });
  };
  for (const source of HANDOVER_SOURCE_FILES) {
    const bytes = readFileSync(checkedFile(projectDir, source));
    if (source.endsWith('.env.example')) validateTemplate(bytes.toString('utf8'));
    if (source.endsWith('.md')) {
      const adapted = adaptDocumentation(bytes.toString('utf8'), source, projectDir);
      add(source, adapted, source);
      if (adapted !== bytes.toString('utf8')) files.get(source).sourceSha256 = sha256(bytes);
    } else add(source, bytes, source);
  }
  const datasets = ['focused-12', 'busy-50'].map(id => {
    const bytes = files.get(`demo-data/${id}.json`).bytes;
    const data = validateDemoDataset(JSON.parse(bytes));
    const events = JSON.parse(files.get(`demo-data/n8n-intake.${id}.json`).bytes);
    if (!Array.isArray(events) || events.length !== data.cases.length || events.some((event, i) =>
      Object.keys(event).sort().join(',') !== 'complaint,eventId,orderId' || event.eventId !== `demo-${id}-${data.cases[i].id}` || event.orderId !== data.cases[i].orderId || event.complaint !== data.cases[i].complaint)) fail('The intake events must match the synthetic dataset exactly.');
    add(`staging/${id}.json`, bytes, `demo-data/${id}.json`);
    return data;
  });
  const workflow = JSON.parse(files.get('integrations/n8n/refund-intake.workflow.json').bytes);
  if (workflow.active !== false) fail('The handover n8n workflow must remain inactive.');
  const packet = await savedExample(datasets[0]);
  const briefing = buildBriefing(packet);
  const input = { complaint: packet.case.complaint, order: packet.order, evidence: packet.case.evidence };
  const { source: ignoredSource, ...proposal } = packet.case.proposal;
  add('examples/saved-case.json', json(packet));
  add('examples/decision-report.md', buildDecisionReport(packet));
  add('examples/openai/request.json', json(await modelExample('openai', input, proposal)));
  add('examples/anthropic/request.json', json(await modelExample('anthropic', input, proposal)));
  add('examples/elevenlabs/briefing.txt', briefing.text + '\n');
  add('examples/elevenlabs/request.json', json(await voiceExample(briefing.text)));
  const board = buildMiroExport(packet);
  add('examples/miro/case-board.json', json(board));
  add('examples/miro/note-requests.json', json({ kind: 'unsent-request-templates', sent: false, boardId: null, liveVerified: false,
    notice: 'Portable local preparation, not a native Miro import or a published board. localId is a local planning hash, not a remote item identity.',
    requests: planMiroNotes(board).map(note => ({ localId: note.localId, method: 'POST', url: 'https://api.miro.com/v2/boards/{MIRO_BOARD_ID}/sticky_notes', body: note.body })) }));
  const document = { id: 'synthetic-packing-example', text: 'Synthetic packing record\nTravel mug: ordered 1, packed 0\nSource: local demonstration fixture' };
  add('examples/modal/input.json', json(document));
  add('examples/modal/expected-output.json', json({ documentId: document.id, sha256: sha256(document.text), lines: document.text.split('\n').map((text, i) => ({ line: i + 1, text })), authoritative: false }));
  add('examples/stripe/scenario.json', json({ kind: 'unsubmitted-test-scenario', synthetic: true, paymentMode: 'local', externalTestRequired: true,
    humanApprovalRequired: true, approved: false, order: packet.order, lineId: proposal.lineId, issue: proposal.issue, amountMinor: proposal.amountMinor, currency: packet.order.currency,
    notice: 'No remote payment identity is supplied. A later authorised test must use the identifiers returned by the real test account and retain the original operation key.' }));
  const service = JSON.parse(files.get('integrations/port/service.example.json').bytes);
  add('examples/port/entity-request.json', json({ kind: 'unsent-request-template', sent: false, liveVerified: false, method: 'POST',
    url: '{PORT_API_URL}/v1/blueprints/{PORT_BLUEPRINT_ID}/entities?upsert=true&merge=true',
    body: { identifier: service.identifier, title: service.title, properties: { readiness: service.status, humanApprovalRequired: true, liveVerified: false }, relations: {} } }));
  add('staging/README.md', '# Synthetic staging inputs\n\nThese are byte-for-byte copies of the validated [focused](../demo-data/focused-12.json) and [busy](../demo-data/busy-50.json) local demo catalogues. They contain synthetic orders, fresh cases, policy and clearly seeded historical local receipts. They contain no human approvals or remote payment identities.\n\nWithin this legacy small pack they are staging input, not SQL, a Supabase import format or an implemented runtime database. Operational runtime preparation is in the separate complete current application. Follow the [migration plan](../docs/SUPABASE-MIGRATION.md) before mapping these records into any hosted store. The first project must remain synthetic and payment submission must remain disabled.\n');
  const sponsors = readiness();
  add('README.md', '# Refund Office legacy sponsor handover\n\nThis legacy small pack prepares examples for all ten sponsors for a later authorised setup session. Preparing it makes no external requests and does not upload, connect, deploy or pay. Every new refund still needs human approval.\n\nThis is a legacy small source and example pack, not a runnable copy of the complete current application. Obtain the complete current Refund Office application separately for its interface, authenticated API, sponsor actions, operational database preparation, package manifest, launchers and tests. The readiness statements below describe only files included in this legacy pack. In that project, `npm run demo:focused` and `npm run demo:busy` run isolated local demonstrations; `npm run handover:prepare` regenerates this pack. Do not run those commands inside this pack.\n\nStart with [online setup preparation](docs/ONLINE-SETUP.md), [sponsor setup details](integrations/SETUP.md) and the [machine-readable manifest](manifest.json). The [Supabase working-database plan](docs/SUPABASE-MIGRATION.md) is separate from the implemented private archive preparation.\n\n| Sponsor | Included example | State within this pack |\n| --- | --- | --- |\n' + sponsors.map(item => `| ${item.name} | [Prepared material](${item.files[0]}) | ${item.status}; disconnected |`).join('\n') + '\n\nThe [saved case](examples/saved-case.json) was investigated in a temporary in-memory database using local rules. Its [decision report](examples/decision-report.md) stops at human review; no approval was granted and no payment was created. Text for ElevenLabs is saved, but no speech was generated. Model requests were captured with injected responses, not sent to a provider.\n\nSee the [dataset guide](demo-data/README.md), [scenario guide](demo-data/SCENARIOS.md) and [staging note](staging/README.md). Local checks and expected outcomes are distinct from service verification. The manifest lists blockers for each sponsor and hashes for all other files.\n\nKeep filled configuration and credentials outside this pack. Templates default to offline/local and do not load themselves. The included Vercel configuration deliberately has no working API; all API methods return 503. The n8n workflow is inactive and contains no review or payment step.\n');
  const bytes = [...files.values()].reduce((total, file) => total + file.bytes.length, 0);
  if (bytes > MAX_PACK_BYTES) fail('The sponsor handover exceeds its five-MiB bound.');
  const manifest = { kind: KIND, schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'offline', connected: false, liveVerified: false,
    humanApprovalRequired: true, containsRuntimeDatabase: false, standaloneApplication: false,
    scope: 'legacy-small-pack', completeCurrentApplicationIncluded: false,
    configuration: { REFUND_OFFICE_NETWORK: 'offline', REFUND_OFFICE_ANALYSER: 'local', REFUND_OFFICE_CHALLENGER: 'none', REFUND_OFFICE_ENABLED_INTEGRATIONS: '' },
    localChecks: ['Both synthetic datasets passed the strict dataset validator.', 'All intake examples match the exact synthetic case inputs.', 'An isolated local investigation stopped at awaiting-approval with no operation.', 'OpenAI and Anthropic requests were captured through injected responses.', 'ElevenLabs transport accepted a discarded mock header; no speech was generated.', 'Miro outline and note bodies were produced by pure local functions.'],
    datasets: datasets.map(data => ({ id: data.id, synthetic: true, cases: data.cases.length, orders: data.orders.length, historicalLocalFixtures: data.seedOperations.length, stagingOnly: true })),
    sponsors, totalContentBytes: bytes,
    files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, source: file.source, ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256, adaptation: 'Links to existing files outside this legacy pack labelled as separate complete-current-application references.' } : {}), bytes: file.bytes.length, sha256: sha256(file.bytes) })),
  };
  checkExisting(outputDir, [...files.keys()]);
  mkdirSync(outputDir, { recursive: true });
  for (const [path, file] of [...files, ['manifest.json', { bytes: Buffer.from(json(manifest)) }]]) {
    const destination = resolve(outputDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    const temp = destination + '.handover-tmp';
    if (existsSync(temp)) fail('A previous handover write is incomplete; inspect it before regeneration.');
    writeFileSync(temp, file.bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, destination);
  }
  return { outputDir, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSponsorHandover().then(({ outputDir, manifest }) => {
    console.log(`Prepared ${manifest.sponsors.length} disconnected sponsors, ${manifest.files.length + 1} files, ${manifest.totalContentBytes} content bytes in ${outputDir}. No external requests were made.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
