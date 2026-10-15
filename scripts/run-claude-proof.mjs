import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { createInvestigationProviders } from '../server/investigation-proposal.mjs';
import { buildDecisionReport } from '../server/integration-prep.mjs';
import { validateDemoDataset, demoDatasetDigest } from '../server/demo-dataset.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CLAUDE_PROOF_CASES = Object.freeze(['SYN-F12-C001', 'SYN-F12-C004', 'SYN-F12-C008']);
const sha = value => createHash('sha256').update(value).digest('hex');
const safeCode = value => typeof value === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(value) ? value : 'proof_failed';
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100) : 'Not recorded';

function snapshotSources() {
  const paths = ['scripts/run-claude-proof.mjs', 'demo-data/focused-12.json', 'package-lock.json',
    ...readdirSync(join(ROOT, 'server')).filter(name => name.endsWith('.mjs')).map(name => 'server/' + name)];
  const files = paths.sort().map(path => ({ path, sha256: sha(readFileSync(join(ROOT, path))) }));
  return { files, digest: sha(JSON.stringify(files)) };
}

export function requireClaudeProofConsent({ env, authorised, responseMode, fetchImpl }) {
  if (authorised !== true) throw new Error('Explicit permission for up to three synthetic Claude investigations is required.');
  if (env.REFUND_OFFICE_NETWORK !== 'enabled' || env.REFUND_OFFICE_ANALYSER !== 'anthropic'
      || !String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(x => x.trim()).includes('anthropic')
      || env.REFUND_OFFICE_ANTHROPIC_MODE !== 'tools') throw new Error('Explicit Anthropic-only tool investigation settings are required.');
  if (!env.ANTHROPIC_API_KEY?.trim() || !/^[A-Za-z0-9._:/-]{1,160}$/.test(env.ANTHROPIC_MODEL || '')) throw new Error('Supply the server-side Anthropic key and an explicit model. Never put the key in a command argument.');
  if (responseMode !== undefined && responseMode !== 'controlled-test') throw new Error('Unknown proof transport mode.');
  if (responseMode === 'controlled-test' ? typeof fetchImpl !== 'function' || fetchImpl === globalThis.fetch : fetchImpl !== undefined) throw new Error('Injected responses must be explicitly labelled controlled-test.');
}

export function renderClaudeProof(manifest, records) {
  const executionLabel = manifest.transport === 'controlled-test' ? 'Controlled responses — no real Claude run' : manifest.liveClaudeRun ? 'Real Claude response recorded' : 'No completed Claude investigation verified';
  const rows = records.map(row => `<article><h2>${html(row.caseLabel)} · ${html(row.category)}</h2><p><strong>${html(row.outcome)}</strong> · ${html(money(row.amountMinor))} proposed · ${row.matchesExpected ? 'Matched the supplied expectation' : 'Did not match the supplied expectation'}</p><p>${html(row.summary)}</p><p>Saved revision ${html(row.revision)}. ${row.checks.filter(x => x.status === 'pass').length} of ${row.checks.length} policy checks passed.</p><p><a href="${html(row.packetFile)}">Saved decision packet</a> · <a href="${html(row.reportFile)}">Readable decision brief</a></p><details><summary>Actual investigation calls and read-only tools</summary><pre>${html(JSON.stringify(row.receipt, null, 2))}</pre></details><details><summary>Saved checks and evidence citations</summary><pre>${html(JSON.stringify({ checks: row.checks, evidenceIds: row.evidenceIds }, null, 2))}</pre></details></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refund Office — Claude run proof</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#0b1621;color:#e8f1f7;margin:0;padding:clamp(18px,4vw,52px)}main{max-width:1040px;margin:auto}h1{font-size:clamp(28px,4vw,42px);line-height:1.2}h2{font-size:22px}article,.boundary{padding:22px;background:#132735;border:1px solid #395362;border-radius:10px;margin:20px 0}a{color:#9fdfc1}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer}code{overflow-wrap:anywhere}.badge{color:#a4e4c3}strong{color:#e3d19d}</style></head><body><main><p class="badge">Synthetic orders · ${html(executionLabel)} · No refund approval</p><h1>From a customer request to a reviewable decision</h1><p>One Claude investigator reads supplied order and evidence records, then hands its recommendation to independent policy checks. A person makes the refund decision.</p><section class="boundary"><h2>${manifest.passed ? 'All three selected cases matched their expectations' : 'Run incomplete or a check failed'}</h2><p>${manifest.caseCount} observed cases · ${manifest.modelRequests} model requests · ${manifest.paymentAttempts} payment attempts · ${manifest.approvals} new approvals</p><p>${html(manifest.completedAt)} · ${html(manifest.transport)} · persisted readback: ${manifest.persistedReadback ? 'confirmed' : 'not confirmed'}</p><p>This proves only the included synthetic investigations. It does not establish customer demand, production accuracy, deployment or payment movement. Request identifiers are locally captured provider metadata, not independently verified by a third party.</p></section>${rows}<p><a href="manifest.json">Run manifest</a> · <a href="receipts.json">Execution receipts</a> · <a href="sources-before.json">Source hashes</a></p><p>Source digest: <code>${html(manifest.sourceDigest)}</code>. Historical synthetic remedies in the supplied pack are not new results from this run.</p></main></body></html>`;
}

// Separate proof database only. No existing demo, account, customer or payment
// transport is accepted. The CLI does not read .env files or select a model.
export async function runClaudeProof({ env = process.env, authorised = false, outputBase = join(ROOT, 'work/claude-proofs'), responseMode, fetchImpl } = {}) {
  requireClaudeProofConsent({ env, authorised, responseMode, fetchImpl });
  const work = join(ROOT, 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  if (lstatSync(work).isSymbolicLink()) throw new Error('The proof working folder must not be a symbolic link.');
  const base = resolve(outputBase);
  if (!base.startsWith(work + '/')) throw new Error('Use a fresh directory inside the project work folder.');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (realpathSync(base) !== base) throw new Error('The proof folder cannot contain symbolic links.');
  const outputDir = mkdtempSync(join(base, responseMode === 'controlled-test' ? 'controlled-' : 'live-'));
  chmodSync(outputDir, 0o700);
  const save = (name, value) => writeFileSync(join(outputDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const before = snapshotSources();
  save('sources-before.json', before);
  const dataset = validateDemoDataset(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
  const datasetDigest = demoDatasetDigest(dataset);
  let modelRequests = 0, paymentAttempts = 0, failure;
  const transport = responseMode === 'controlled-test' ? 'controlled-test' : 'provider-response';
  const connection = fetchImpl || globalThis.fetch;
  const boundedFetch = async (url, options) => {
    if (url !== 'https://api.anthropic.com/v1/messages' || options?.method !== 'POST' || modelRequests >= 12) throw Object.assign(new Error('The proof transport refused this request.'), { code: 'proof_transport_blocked' });
    modelRequests++;
    return connection(url, options);
  };
  // Do not pass ambient Stripe, Supabase, telemetry or other sponsor settings.
  const selected = createInvestigationProviders({ env: {
    REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'anthropic',
    REFUND_OFFICE_ANTHROPIC_MODE: 'tools', ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
  }, fetchImpl: boundedFetch, ...(responseMode ? { responseMode } : {}) });
  const neverPay = async () => { paymentAttempts++; throw new Error('Payment execution is absent from the Claude proof runner.'); };
  const provider = { ...selected, capabilities: () => ({ ...selected.capabilities(), payments: 'disabled', paymentSubmission: false }), createRefund: neverPay, retrieveRefund: neverPay };
  const dbPath = join(outputDir, 'synthetic-run.sqlite');
  let store = createStore({ dbPath, dataset });
  const records = [], outcomes = [];
  let persistedReadback = false;
  try {
    const engine = createEngine({ store, provider });
    for (const id of CLAUDE_PROOF_CASES) {
      const expected = dataset.scenarios.find(row => row.caseId === id);
      let item = await engine.run(id);
      for (let step = 0; item.status === 'running' && step < 4; step++) item = await engine.advance(id, { expectedRevision: item.revision });
      const packet = engine.exportCase(id);
      const receipt = selected.receipts().at(-1) || null;
      const record = { caseId: id, caseLabel: item.caseId, category: expected.category, revision: item.revision,
        outcome: item.outcome, amountMinor: item.proposedAmountMinor, summary: item.summary,
        checks: item.checks, evidenceIds: item.proposal?.evidenceIds || [], receipt,
        packetFile: `${id}.packet.json`, reportFile: `${id}.brief.md`,
        matchesExpected: item.outcome === expected.expectedOutcome && item.proposedAmountMinor === expected.expectedAmountMinor && item.stage === 'review' && item.approval?.state !== 'approved' && !item.operationId && !item.receipt };
      records.push(record); outcomes.push(structuredClone(item));
      save(record.packetFile, packet);
      const proofLabel = transport === 'controlled-test' ? 'Controlled responses only. No real Claude run occurred.' : receipt?.status === 'completed' ? 'A real Claude response was recorded for this investigation.' : 'No completed Claude investigation is verified for this case.';
      save(record.reportFile, `# Investigation proof scope\n\n${proofLabel}\n\nSynthetic case: ${item.caseId}. Transport: ${transport}. Receipt reference: ${receipt?.id || 'Not recorded'}. Input hash: ${receipt?.inputHash || 'Not recorded'}.\n\nThis is a recommendation or hold, not a refund approval or payment.\n\n---\n\n${buildDecisionReport(packet)}`);
      if (item.status === 'error' || !receipt || receipt.status !== 'completed') break;
    }
    store.close(); store = null;
    store = createStore({ dbPath, expectedDatasetId: dataset.id, expectedDatasetDigest: datasetDigest });
    persistedReadback = outcomes.every(item => JSON.stringify(store.getCase(item.id)) === JSON.stringify(item));
  } catch (error) { failure = safeCode(error.code); }
  const operations = store ? store.orders().flatMap(order => store.operations(order.id)) : [];
  const approvals = store ? store.cases().filter(item => item.approval?.state === 'approved').length : 0;
  const newOperations = operations.filter(operation => !dataset.seedOperations.some(seed => seed.id === operation.id)).length;
  store?.close();
  const after = snapshotSources(), receipts = selected.receipts();
  save('sources-after.json', after); save('receipts.json', receipts); save('observed-cases.json', outcomes);
  const passed = !failure && records.length === 3 && records.every(row => row.matchesExpected && row.receipt?.status === 'completed')
    && persistedReadback && !paymentAttempts && !approvals && !newOperations && before.digest === after.digest;
  const manifest = { schemaVersion: 1, completedAt: new Date().toISOString(), synthetic: true, transport,
    liveClaudeRun: transport === 'provider-response' && modelRequests > 0 && receipts.some(row => row.status === 'completed'),
    architecture: 'one-claude-investigator-read-only-tools-deterministic-policy-human-decision',
    passed, caseCount: records.length, requestedCases: CLAUDE_PROOF_CASES, modelRequests, paymentAttempts, approvals, newOperations,
    persistedReadback, sourceUnchanged: before.digest === after.digest, sourceDigest: before.digest, datasetDigest,
    configuredModel: env.ANTHROPIC_MODEL, failure: failure || null, outputDir };
  save('manifest.json', manifest); save('index.html', renderClaudeProof(manifest, records));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--authorised-synthetic') {
    console.error('Use --authorised-synthetic only after permission for up to three fictional investigations. Configure the key privately in the server environment, never in arguments.');
    process.exitCode = 1;
  } else {
    runClaudeProof({ authorised: true }).then(manifest => {
      console.log(JSON.stringify(manifest));
      if (!manifest.passed) process.exitCode = 1;
    }).catch(() => { console.error('Claude proof could not start. Check explicit provider settings and private credentials. No successful run is claimed.'); process.exitCode = 1; });
  }
}
