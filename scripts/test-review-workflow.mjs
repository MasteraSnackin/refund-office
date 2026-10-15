import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { prepareSyntheticImport } from '../server/supabase-import.mjs';
import { createLocalPostgresRuntime } from '../server/local-postgres-runtime.mjs';
import { createRuntimeService } from '../server/runtime-service.mjs';
import { createProviders } from '../server/providers.mjs';
import { createLocalObserver } from '../server/observability.mjs';
import { buildCustomerClarificationDraft } from '../server/customer-drafts.mjs';
import { caseQueue, summariseReviewQueue } from '../src/case-view.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = ['002_office_workflow.sql', '003_hosted_access.sql', '004_payment_execution.sql', '005_sponsor_actions.sql', '006_payment_review.sql', '007_evidence_clarification.sql', '008_model_investigation.sql'];
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function sourceSnapshot() {
  const files = new Map();
  function visit(path) {
    const absolute = resolve(ROOT, path);
    if (!absolute.startsWith(ROOT)) throw new Error('An exercised source is outside the project.');
    path = relative(ROOT, absolute); if (files.has(path)) return;
    const bytes = readFileSync(absolute); files.set(path, { path, sha256: hash(bytes), bytes: bytes.length });
    if (/\.[cm]?js$/.test(path)) for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) visit(relative(ROOT, resolve(dirname(absolute), match[1])));
  }
  for (const path of ['scripts/test-review-workflow.mjs', 'tests/supabase-runtime/bootstrap.sql', 'integrations/supabase/runtime/001_runtime.sql', ...MIGRATIONS.map(name => `integrations/supabase/runtime/${name}`), 'demo-data/focused-12.json']) visit(path);
  const rows = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { digest: hash(JSON.stringify(rows)), files: rows };
}

/** Real database checks only in an owned networkless disposable container. */
export async function runReviewWorkflowChecks({ outputBase = join(ROOT, 'work/review-workflow') } = {}) {
  const base = resolve(outputBase);
  if (!base.startsWith(join(ROOT, 'work') + '/')) throw new Error('Use a project work directory for the verification record.');
  mkdirSync(base, { recursive: true });
  const outputDir = mkdtempSync(join(base, 'run-'));
  const save = (name, value) => writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const before = sourceSnapshot(); save('sources-before.json', before);
  const originalFetch = globalThis.fetch; let externalRequests = 0, verification, failure;
  globalThis.fetch = async () => { externalRequests++; throw new Error('External requests are disabled by the review workflow verifier.'); };
  const details = { controlledFailure: 'One invalid_proposal thrown locally for the first claimed case; no model response or provider request is implied.', fixtureBoundary: 'The underlying schema harness has separate isolated approval/reservation fixtures. This new evaluated tenant never approves, reserves or submits a refund.' };
  try {
    verification = await runSupabaseRuntimeChecks({ outputDir, additionalChecks: async ({ sql, value, check, quote }) => {
      const tenantId = randomUUID(), reviewerId = randomUUID(), investigatorId = randomUUID(), workerId = randomUUID();
      const uuid = input => `${quote(input)}::uuid`, json = input => `${quote(JSON.stringify(input))}::jsonb`;
      const reviewer = { tenantId, userId: reviewerId, role: 'reviewer' }, investigator = { tenantId, userId: investigatorId, role: 'investigator' }, worker = { tenantId, userId: workerId, role: 'investigator' };
      const prepared = prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT, 'demo-data/focused-12.json'), 'utf8')));
      const executeSql = async ({ statement, userId, role }) => {
        const result = await sql(statement, { userId, role, allowFailure: true });
        if (result.code !== 0) throw Object.assign(new Error('Isolated review workflow SQL rejected.'), { sqlState: result.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] });
        const body = result.stdout.trim(); return body ? JSON.parse(body.split('\n').at(-1)) : null;
      };
      const repositoryForSession = profile => createLocalPostgresRuntime({ executeSql, tenantId, profile });
      const reviewerRepo = repositoryForSession(reviewer), workerRepo = repositoryForSession(worker);
      const claims = [], proposals = [], failures = [], readsAfterFailure = [];
      let claimPolls = 0, failurePendingRead = false, injected = false, firstClaim;
      const trackedWorker = { ...workerRepo,
        async claimIntake(input) { claimPolls++; const claim = await workerRepo.claimIntake(input); if (claim) { claims.push({ caseId: claim.caseId, requestId: claim.requestId, fence: claim.fence }); firstClaim ||= structuredClone(claim); } return claim; },
        async failIntake(input) { const saved = await workerRepo.failIntake(input); failures.push(structuredClone(saved)); failurePendingRead = true; return saved; },
        async readWorkspace() { const saved = await workerRepo.readWorkspace(); if (failurePendingRead) { readsAfterFailure.push(structuredClone(saved)); failurePendingRead = false; } return saved; },
      };
      const local = createProviders({ env: {} });
      const providers = { capabilities: local.capabilities, async proposeCase(input) {
        proposals.push(input.order.id);
        if (!injected) { injected = true; throw Object.assign(new Error('Deliberate isolated proposal validation fixture.'), { code: 'invalid_proposal' }); }
        return local.proposeCase(input);
      } };
      const observer = createLocalObserver({ filePath: join(outputDir, 'review-workflow.traces.jsonl'), runId: randomUUID(), projectName: 'refund-office-review-check' });
      const makeService = () => createRuntimeService({ repositoryForSession, workerRepository: trackedWorker, workerDelayMs: 5, evidenceClarification: true, investigationProviders: providers, observer, packId: 'focused-12' });
      const noPayments = () => value(`select jsonb_build_object('approvals',(select count(*) from refund_runtime.approvals where tenant_id=${uuid(tenantId)}),'newOperations',(select count(*) from refund_runtime.operations where tenant_id=${uuid(tenantId)} and not seeded),'paymentExecutions',(select count(*) from refund_runtime.payment_executions where tenant_id=${uuid(tenantId)}));`);
      const waitFor = async predicate => {
        const deadline = Date.now() + 30000;
        for (;;) { const snapshot = await reviewerRepo.readWorkspace(); if (predicate(snapshot)) return snapshot; assert.ok(Date.now() < deadline, 'The real investigation queue did not reach the expected saved state.'); await delay(25); }
      };
      let service, initial, afterQueue, failedCase, target, originalDraft;
      try {
        await check('review workflow imports a fresh twelve-case tenant with every provider and payment submission disabled', async () => {
          for (const name of MIGRATIONS) await sql(readFileSync(join(ROOT, 'integrations/supabase/runtime', name), 'utf8'));
          await sql(`insert into auth.users(id) values(${uuid(reviewerId)}),(${uuid(investigatorId)}),(${uuid(workerId)});`);
          await value(`select public.refund_runtime_import_dataset(${uuid(tenantId)},${json(prepared.data)},${quote(prepared.manifest.digest)},${json([reviewer, investigator, worker].map(({ userId, role }) => ({ userId, role })))});`);
          initial = await reviewerRepo.readWorkspace(); assert.equal(initial.cases.length, 12);
          assert.equal(initial.paymentsEnabled, false); assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0, paymentExecutions: 0 });
          service = makeService(); const bootstrap = await service.bootstrap(reviewer);
          assert.equal(bootstrap.capabilities.networkMode, 'offline'); assert.equal(bootstrap.capabilities.paymentSubmission, false); assert.equal(bootstrap.capabilities.analyser, 'local');
          return { cases: 12, networkMode: bootstrap.capabilities.networkMode, paymentSubmission: false, controlledFailure: 'local invalid_proposal fixture only' };
        });
        await check('one real durable proposal failure is independently confirmed and the automatic worker completes the other eleven cases', async () => {
          service.start(); afterQueue = await waitFor(saved => saved.intakeRequests.every(request => !['queued', 'running'].includes(request.status)));
          assert.equal(service.workerState().enabled, true); assert.equal(service.workerState().completed, 11); assert.equal(service.workerState().failed, 1);
          assert.equal(failures.length, 1); assert.equal(readsAfterFailure.length, 1); assert.equal(claims.length, 12);
          failedCase = afterQueue.cases.find(item => item.id === firstClaim.caseId);
          const request = afterQueue.intakeRequests.find(item => item.id === firstClaim.requestId), independentlyRead = readsAfterFailure[0];
          assert.equal(request.status, 'error'); assert.equal(request.lastError, 'invalid_proposal'); assert.equal(request.fence, firstClaim.fence); assert.equal(request.attempts, 1); assert.equal(request.leaseUntil, undefined);
          assert.deepEqual(independentlyRead.intakeRequests.find(item => item.id === request.id), request);
          assert.equal(failedCase.status, 'paused'); assert.equal(failedCase.stage, 'review'); assert.equal(failedCase.outcome, 'held'); assert.equal(failedCase.revision, firstClaim.case.revision + 1);
          assert.deepEqual(failedCase.events.at(-1).payload, { fence: firstClaim.fence, errorCode: 'invalid_proposal' }); assert.equal(failedCase.events.at(-1).actor, workerId);
          assert.deepEqual(independentlyRead.cases.find(item => item.id === failedCase.id), failedCase);
          assert.deepEqual(service.workerState().lastFailure, { caseId: failedCase.id, code: 'invalid_proposal', safelyHeld: true });
          for (const scenario of prepared.data.scenarios.filter(item => item.caseId !== failedCase.id)) { const actual = afterQueue.cases.find(item => item.id === scenario.caseId); assert.equal(actual.outcome, scenario.expectedOutcome); assert.equal(actual.proposedAmountMinor, scenario.expectedAmountMinor); }
          assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0, paymentExecutions: 0 });
          save('queue-after-controlled-failure.json', afterQueue);
          details.controlledCaseFailure = { label: failedCase.caseId, outcome: failedCase.outcome, requestStatus: request.status, fence: request.fence, attempts: request.attempts, independentlyConfirmed: true, otherCasesCompleted: 11 };
          return details.controlledCaseFailure;
        });
        await check('service restart polls the real queue without retrying the failed case or modifying saved decisions', async () => {
          await service.close(); const beforeRestart = await reviewerRepo.readWorkspace(), polls = claimPolls;
          service = makeService(); service.start();
          const deadline = Date.now() + 5000; while (claimPolls === polls) { assert.ok(Date.now() < deadline); await delay(10); }
          await delay(100); assert.deepEqual(await reviewerRepo.readWorkspace(), beforeRestart); assert.equal(claims.length, 12);
          assert.equal(claims.filter(item => item.caseId === failedCase.id).length, 1); assert.equal(proposals.filter(id => id === firstClaim.order.id).length, 1);
          return { restartPolled: true, failedCaseAutomaticallyRetried: false, savedWorkspaceUnchanged: true };
        });
        await check('real saved cases produce distinct human-decision, recovery and hold queues with role-appropriate next actions', async () => {
          const bootstrap = await service.bootstrap(reviewer), summary = summariseReviewQueue(bootstrap.cases);
          assert.deepEqual(summary, { decision: 5, evidence: 0, recovery: 1, holds: 5 });
          const failure = bootstrap.cases.find(item => item.id === failedCase.id), pending = bootstrap.cases.find(item => item.outcome === 'awaiting-approval');
          const classify = (item, permissions) => caseQueue(item, { capabilities: bootstrap.capabilities, permissions });
          assert.equal(classify(failure, { investigate: true }).actionable, true); assert.equal(classify(failure, { review: true }).actionable, false);
          assert.equal(classify(pending, { review: true }).actionable, true); assert.equal(classify(pending, { investigate: true }).actionable, false);
          details.queue = summary; return { ...summary, reviewerCannotRecover: true, investigatorCannotDecide: true };
        });
        await check('reviewer and investigator read the same source-bound customer draft without changing the held case or report', async () => {
          target = afterQueue.cases.find(item => item.caseId === 'RF-2008'); assert.ok(target); assert.notEqual(target.id, failedCase.id);
          const beforeRead = await reviewerRepo.readWorkspace(), reportBefore = await service.report(reviewer, target.id);
          originalDraft = await service.customerDraft(reviewer, target.id); const investigatorDraft = await service.customerDraft(investigator, target.id);
          assert.deepEqual(originalDraft, investigatorDraft); assert.equal(originalDraft.unsent, true); assert.equal(originalDraft.eligible, true);
          assert.match(originalDraft.draftText, /“Sketchbook” or “Marker set”/); assert.doesNotMatch(originalDraft.draftText, /Paper clips|refund|approved|packing/i);
          const packet = await service.exportCase(reviewer, target.id); assert.deepEqual(originalDraft, buildCustomerClarificationDraft(packet));
          assert.equal(originalDraft.sourceBinding.caseId, target.id); assert.equal(originalDraft.sourceBinding.revision, target.revision);
          assert.match(originalDraft.sourceBinding.evidenceDigest, /^[a-f0-9]{64}$/);
          if (target.fingerprint) assert.equal(originalDraft.sourceBinding.fingerprint, target.fingerprint);
          else assert.equal(Object.hasOwn(originalDraft.sourceBinding, 'fingerprint'), false);
          assert.equal((await service.report(reviewer, target.id)).text, reportBefore.text); assert.deepEqual(await reviewerRepo.readWorkspace(), beforeRead);
          save('customer-draft-unsent.json', originalDraft);
          details.draft = { label: target.caseId, eligible: true, unsent: true, revision: target.revision, evidenceDigest: originalDraft.sourceBinding.evidenceDigest, bothProfilesReadOnly: true };
          return details.draft;
        });
        await check('requesting evidence moves the saved case into the evidence queue and makes the earlier draft revision stale', async () => {
          target = await service.review(reviewer, target.id, { expectedRevision: target.revision, action: 'request-evidence', commandId: randomUUID(), note: 'Fictional rehearsal: ask which omitted item the customer is claiming.' });
          assert.equal(target.review.state, 'awaiting-evidence');
          const bootstrap = await service.bootstrap(reviewer), actual = bootstrap.cases.find(item => item.id === target.id);
          assert.deepEqual(summariseReviewQueue(bootstrap.cases), { decision: 5, evidence: 1, recovery: 1, holds: 4 });
          assert.equal(caseQueue(actual, { capabilities: bootstrap.capabilities, permissions: { review: true } }).group, 'evidence');
          const refreshed = await service.customerDraft(reviewer, target.id); assert.equal(refreshed.eligible, true); assert.ok(refreshed.sourceBinding.revision > originalDraft.sourceBinding.revision);
          assert.equal(originalDraft.sourceBinding.revision, afterQueue.cases.find(item => item.id === target.id).revision);
          return { waitingEvidence: true, priorDraftRevisionStale: true, noMessageSent: true };
        });
        await check('a recorded fictional clarification reinvestigates to a fresh unapproved recommendation and retires the draft', async () => {
          const beforeClarification = await reviewerRepo.readWorkspace(), priorTarget = beforeClarification.cases.find(item => item.id === target.id);
          const clarification = { expectedRevision: target.revision, lineId: 'SYN-F12-O008-L1', customerStatement: 'The Sketchbook is missing from my order.', sourceReference: 'Fictional offline workflow verifier reply', note: 'Record this fictional statement for investigation; it does not approve a refund.', commandId: randomUUID() };
          await assert.rejects(service.submitClarification(investigator, target.id, clarification), error => error.status === 403);
          assert.deepEqual(await reviewerRepo.readWorkspace(), beforeClarification);
          const result = await service.submitClarification(reviewer, target.id, clarification); assert.equal(result.readbackVerified, true); assert.equal(result.submission.actor, reviewerId);
          const afterClarification = await waitFor(saved => saved.cases.find(item => item.id === target.id)?.outcome === 'awaiting-approval');
          target = afterClarification.cases.find(item => item.id === target.id);
          assert.equal(target.proposedAmountMinor, 1000); assert.equal(target.approval, null); assert.equal(target.operationId, null); assert.equal(target.receipt, null);
          assert.equal(target.complaint, priorTarget.complaint); assert.deepEqual(afterClarification.orders, initial.orders);
          for (const entry of priorTarget.evidence) assert.deepEqual(target.evidence.find(item => item.id === entry.id), entry);
          assert.equal(target.evidence.find(item => item.kind === 'customer-clarification').body, clarification.customerStatement);
          assert.deepEqual(afterClarification.cases.filter(item => item.id !== target.id), beforeClarification.cases.filter(item => item.id !== target.id));
          const beforeOutput = await reviewerRepo.readWorkspace(), retired = await service.customerDraft(reviewer, target.id), report = await service.report(reviewer, target.id);
          assert.equal(retired.eligible, false); assert.equal(retired.unsent, true); assert.equal(retired.draftText, ''); assert.ok(retired.sourceBinding.revision > originalDraft.sourceBinding.revision);
          assert.ok(report.text.includes(clarification.customerStatement)); assert.ok(report.text.includes(clarification.sourceReference)); assert.ok(report.text.includes(priorTarget.complaint));
          assert.deepEqual(await reviewerRepo.readWorkspace(), beforeOutput);
          assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0, paymentExecutions: 0 });
          save('clarification-after.json', afterClarification); save('retired-customer-draft.json', retired); save('clarification-report.json', report);
          details.clarification = { label: target.caseId, amountMinor: 1000, awaitingUserApproval: true, earlierDraftStale: true, currentDraftEligible: false, otherCasesUnchanged: 11, approvals: 0, newOperations: 0, paymentExecutions: 0 };
          return details.clarification;
        });
        await check('actual failure and clarification traces retain correct outcomes and contain no customer text or provider activity', async () => {
          await observer.flush(); const snapshot = observer.snapshot(), investigations = snapshot.spans.filter(span => span.name === 'refund.investigation');
          const failed = investigations.filter(span => span.status === 'ERROR'); assert.equal(failed.length, 1); assert.equal(failed[0].attributes.outcome, 'held');
          assert.equal(investigations.filter(span => span.status === 'OK').length, 12);
          assert.equal(snapshot.spans.filter(span => span.name === 'refund.investigation.hold').length, 1); assert.equal(snapshot.spans.filter(span => span.name === 'refund.investigation.verify-hold').length, 1);
          assert.ok(snapshot.spans.every(span => span.attributes.provider === 'local')); assert.equal(externalRequests, 0);
          const serialised = JSON.stringify(snapshot); for (const privateValue of [tenantId, reviewerId, investigatorId, workerId, target.id, 'Fictional offline workflow verifier reply', 'The Sketchbook is missing from my order.']) assert.ok(!serialised.includes(privateValue));
          assert.deepEqual(await noPayments(), { approvals: 0, newOperations: 0, paymentExecutions: 0 }); save('traces.json', snapshot);
          details.traces = { spans: snapshot.spans.length, failedInvestigations: 1, successfulInvestigations: 12, externalRequests: 0, privacy: 'allowlisted metadata only' }; return details.traces;
        });
      } finally { if (service) await service.close(); }
    } });
  } catch (error) { failure = error; }
  finally { globalThis.fetch = originalFetch; }
  const after = sourceSnapshot(); save('sources-after.json', after);
  const verificationPath = join(outputDir, 'verification.json');
  const database = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : null;
  const cleanedUp = database?.database.cleanedUp === true;
  const passed = !failure && verification?.passed === true && cleanedUp && before.digest === after.digest && externalRequests === 0;
  const manifest = { schemaVersion: 1, passed, synthetic: true, uploaded: false, scope: 'Actual local service and repositories against a fresh networkless PostgreSQL tenant. No online account, provider API or real authentication is tested.', ...details, externalRequests, sourceUnchanged: before.digest === after.digest, sourceDigest: before.digest, databaseChecks: verification?.checks || 0, ownedDatabaseRemoved: cleanedUp, outputDir, failure: failure?.message || null };
  save('manifest.json', manifest);
  if (!passed) throw new Error(`Review workflow verification did not pass. Inspect ${join(outputDir, 'manifest.json')}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runReviewWorkflowChecks().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
