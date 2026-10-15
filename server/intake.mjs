import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './engine.mjs';

const timestamp = () => new Date().toISOString();
const runnable = new Set(['queued', 'running']);
const investigationStages = new Set(['reception', 'evidence', 'policy']);
const publicRequest = ({ id, eventId, caseId, caseLabel, orderId, status, createdAt, updatedAt, lastError }) => ({
  id, eventId, caseId, caseLabel, orderId, status, createdAt, updatedAt, ...(lastError ? { lastError } : {}),
});

// This worker deliberately knows no payment provider and never calls approve,
// advance or reconcile. Its only progression capability is advanceIntake.
export function createIntake({ store, engine, stepDelayMs = 850 } = {}) {
  if (!Number.isSafeInteger(stepDelayMs) || stepDelayMs < 1) throw new Error('The intake step delay must be a positive whole number.');
  let started = false;
  let stopped = false;
  let timer = null;
  let active = null;

  function find(id) {
    const request = store.intakeRequest(id);
    if (!request) throw new ApiError(404, 'intake_not_found', 'That intake request does not exist.');
    return request;
  }
  function classify(item) {
    if (item.status === 'paused') return 'paused';
    if (item.status === 'error') return 'error';
    if (item.outcome === 'already-resolved') return 'already-resolved';
    if (item.status === 'review') return item.outcome === 'awaiting-approval' ? 'awaiting-review' : 'blocked';
    if (item.status === 'closed') return 'blocked';
    if (item.operationId || item.receipt || item.approval?.state === 'approved' || item.stage === 'payments' || item.status === 'pending') return 'handoff-complete';
    if (item.status === 'ready' && investigationStages.has(item.stage)) return 'queued';
    if (item.status === 'running' && investigationStages.has(item.stage)) return 'running';
    return 'blocked';
  }
  function record(request, item, message = null) {
    const status = classify(item);
    request.status = status;
    request.updatedAt = timestamp();
    if (message || status === 'error') request.lastError = message || item.summary;
    else delete request.lastError;
    store.saveIntake(request);
    return request;
  }
  function wake() {
    if (!started || stopped || timer || active || !store.intakeRequests().some(request => runnable.has(request.status))) return;
    timer = setTimeout(() => {
      timer = null;
      active = step().finally(() => { active = null; wake(); });
    }, stepDelayMs);
    timer.unref?.();
  }
  async function step() {
    const request = store.intakeRequests().find(item => runnable.has(item.status));
    if (!request || stopped) return;
    try {
      const item = engine.getCase(request.caseId);
      if (!runnable.has(classify(item))) { record(request, item); return; }
      if ((request.attempts || 0) >= 8) throw new ApiError(409, 'intake_step_limit', 'The investigation exceeded its bounded step allowance. Review the saved case before resuming.');
      request.status = 'running'; request.attempts = (request.attempts || 0) + 1;
      request.updatedAt = timestamp(); store.saveIntake(request);
      const result = await engine.advanceIntake(request.caseId, request.id);
      record(store.intakeRequest(request.id), result);
    } catch (error) {
      // An approval or manual pause may have won the case lock. Record the
      // resulting handoff without changing the case or touching its operation.
      let item;
      try { item = engine.getCase(request.caseId); } catch { /* A corrupt request is recorded as an error. */ }
      if (item && !runnable.has(classify(item))) record(store.intakeRequest(request.id), item);
      else {
        const message = error instanceof ApiError ? error.message : 'The local intake investigation failed. Saved progress is preserved; no refund was submitted.';
        let stoppedCase;
        try { stoppedCase = await engine.failIntake(request.caseId, request.id, message); }
        catch { /* Missing or mismatched ownership must never alter another case. */ }
        const current = store.intakeRequest(request.id);
        if (stoppedCase) record(current, stoppedCase);
        else {
          current.status = 'error'; current.updatedAt = timestamp(); current.lastError = message;
          store.saveIntake(current);
        }
      }
    }
  }

  return {
    list() { return { requests: store.intakeRequests().map(publicRequest), mode: 'local' }; },
    submit(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_intake', 'Provide an intake event as a JSON object.');
      if (typeof input.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.eventId)) throw new ApiError(400, 'invalid_event_id', 'Provide an event ID of 1 to 120 letters, numbers, dots, underscores, colons or hyphens.');
      if (typeof input.orderId !== 'string' || typeof input.complaint !== 'string') throw new ApiError(400, 'invalid_intake', 'Provide an order ID and complaint as text.');
      const payloadHash = createHash('sha256').update(JSON.stringify({ orderId: input.orderId, complaint: input.complaint.trim() })).digest('hex');
      const result = store.transaction(() => {
        const existing = store.intakeByEvent(input.eventId);
        if (existing) {
          if (existing.payloadHash !== payloadHash) throw new ApiError(409, 'intake_event_conflict', 'This event ID was already saved with different details. Retry its original payload or use a new event ID.');
          return { request: publicRequest(existing), case: engine.getCase(existing.caseId), replayed: true };
        }
        const item = engine.createCase(input);
        const at = timestamp();
        const request = { id: randomUUID(), eventId: input.eventId, caseId: item.id, caseLabel: item.caseId, orderId: item.orderId, status: 'queued', createdAt: at, updatedAt: at, payloadHash, attempts: 0 };
        item.intakeManaged = true; item.intakeRequestId = request.id;
        item.events.push({ id: randomUUID(), at, station: 'reception', label: 'Local intake event saved', detail: `Event ${request.eventId} created this case. Repeating the same event returns this saved case. No external workflow was contacted.` });
        item.revision += 1;
        store.saveCase(item); store.saveIntake(request);
        return { request: publicRequest(request), case: item, replayed: false };
      });
      wake();
      return result;
    },
    async resume(id) {
      const request = find(id);
      const current = engine.getCase(request.caseId);
      // A worker-level failure can leave a safe running case behind. Explicit
      // retry may requeue that case, but cannot enter review or payment stages.
      let item;
      if (request.status === 'error' && ['ready', 'running'].includes(current.status) && investigationStages.has(current.stage) && !current.operationId && !current.receipt && current.approval?.state !== 'approved') {
        if (!current.intakeManaged || current.intakeRequestId !== request.id) throw new ApiError(409, 'intake_not_owner', 'This request does not own the saved case.');
        item = current;
      } else item = await engine.resumeIntake(request.caseId, request.id);
      request.attempts = 0; record(request, item); wake();
      return { request: publicRequest(request), case: item };
    },
    notifyCaseChanged(caseId, { restart = false } = {}) {
      const item = engine.getCase(caseId);
      const request = item.intakeRequestId && store.intakeRequest(item.intakeRequestId);
      if (!request || request.caseId !== item.id || !item.intakeManaged) return;
      if (restart) request.attempts = 0;
      record(request, item); wake();
    },
    start() {
      if (stopped) throw new Error('A closed intake worker cannot restart.');
      started = true;
      for (const request of store.intakeRequests()) {
        if (!runnable.has(request.status)) continue;
        try { record(request, engine.getCase(request.caseId)); }
        catch { request.status = 'error'; request.updatedAt = timestamp(); request.lastError = 'The saved intake case could not be found. Manual review is required.'; store.saveIntake(request); }
      }
      wake();
    },
    async close() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (active) await active;
    },
  };
}
