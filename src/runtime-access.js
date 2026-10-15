export const isRuntimeWorkspace = data => data?.capabilities?.runtime === true || data?.runtime?.mode === 'local-postgres-rehearsal';
export const isReserved = item => item?.outcome === 'approved-not-submitted' || item?.status === 'reserved';
export const runtimePermissions = session => ({ review: session?.role === 'reviewer', investigate: session?.role === 'investigator' });

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const commandKey = ({ workspaceId, profileId, caseId, action }) => `refund-office-runtime-command:${workspaceId}:${profileId}:${caseId}:${action}`;

export function readRuntimeCommand(storage, context) {
  try {
    const key = commandKey(context), saved = JSON.parse(storage.getItem(key));
    return saved?.commandId && saved.payload && typeof saved.payload === 'object' ? { key, action: context.action, ...saved } : null;
  } catch { return null; }
}

// Persist the full human decision before POST. An uncertain retry must retain
// both its identity and its facts; editing it cannot silently create a new write.
export function prepareRuntimeCommand(storage, context, payload, createId = () => crypto.randomUUID()) {
  const key = commandKey(context);
  let saved;
  try { const raw = storage.getItem(key); saved = raw ? JSON.parse(raw) : null; }
  catch { throw new Error('The saved decision could not be read. Keep this tab open and inspect the case before retrying.'); }
  if (saved) {
    if (!saved.commandId || canonical(saved.payload) !== canonical(payload)) throw new Error('A previous decision is still awaiting confirmation. Keep its original details and retry it before recording a changed decision.');
    return { key, body: { ...saved.payload, commandId: saved.commandId }, replay: true };
  }
  const commandId = createId();
  try { storage.setItem(key, JSON.stringify({ commandId, payload })); }
  catch { throw new Error('This browser could not save the decision retry details. Enable session storage before recording a decision.'); }
  return { key, body: { ...payload, commandId }, replay: false };
}

export function completeRuntimeCommand(storage, key) { try { storage.removeItem(key); } catch { /* A retained retry identity remains safe. */ } }
export const isDefinitiveCommandFailure = error => error?.uncertain !== true && [400, 409, 422].includes(error?.status);

export function verifyRuntimeDecision(record, caseId, { approval } = {}) {
  const validCase = record && record.id === caseId && Number.isSafeInteger(record.revision) && record.revision > 0;
  const validApproval = !approval || record?.outcome === 'approved-not-submitted' && record?.approval?.state === 'approved'
    && record.approval.amountMinor === approval.expectedAmountMinor && record.approval.fingerprint === approval.fingerprint
    && typeof record.operationId === 'string' && record.operationId.length > 0 && !record.receipt && record.paymentSubmissionEnabled === false;
  if (!validCase || !validApproval) {
    const error = new Error('The decision response could not be verified. Its original request is saved; inspect the case and retry that same request.');
    error.uncertain = true; throw error;
  }
  return record;
}
