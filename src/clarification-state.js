const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const keys = ['expectedRevision', 'lineId', 'customerStatement', 'sourceReference', 'note', 'commandId'];
export const clarificationStorageKey = ({ tenantId, userId, role, caseId, runId }) => `refund-office:evidence-clarification:${tenantId}:${userId}:${role}:${caseId}${runId ? ':' + runId : ''}`;
export const hasClarificationIdentity = scope => uuid.test(scope?.tenantId || '') && uuid.test(scope?.userId || '');

export function makeClarificationCommand({ expectedRevision, lineId, customerStatement, sourceReference, note }, commandId) {
  if (!positive(expectedRevision) || !id(lineId) || !text(customerStatement, 10, 4000) || !text(sourceReference, 10, 200) || !text(note, 10, 2000) || !uuid.test(commandId || '')) {
    throw new Error('Select an existing order item, add a received statement of 10–4,000 characters, a source reference of 10–200 characters and a reason of 10–2,000 characters.');
  }
  return { expectedRevision, lineId, customerStatement: customerStatement.trim(), sourceReference: sourceReference.trim(), note: note.trim(), commandId };
}

export function readClarificationCommand(storage, key) {
  const raw = storage.getItem(key); if (raw === null) return null;
  try {
    const saved = JSON.parse(raw), checked = makeClarificationCommand(saved, saved.commandId);
    if (Object.keys(saved).length !== keys.length || keys.some(key => saved[key] !== checked[key])) throw Error('Changed command');
    return saved;
  } catch { throw new Error('The saved clarification request could not be read safely. New statements are blocked until its recorded result is checked.'); }
}

export function verifyClarificationSubmission(submission, { command, userId } = {}) {
  if (!record(submission) || !uuid.test(submission.id || '') || !uuid.test(submission.commandId || '') || submission.kind !== 'customer-clarification'
    || !id(submission.lineId) || !text(submission.body, 10, 4000) || !text(submission.sourceReference, 10, 200) || !text(submission.note, 10, 2000)
    || !positive(submission.expectedRevision) || !uuid.test(submission.actor || '') || !Number.isFinite(Date.parse(submission.at))) throw new Error('A saved customer clarification could not be verified.');
  if (command && (keys.some(key => submission[key === 'customerStatement' ? 'body' : key] !== command[key]) || submission.actor !== userId)) throw new Error('The saved customer clarification differs from the exact received statement or reviewer.');
  return submission;
}

export function verifyClarificationContext(value, scope) {
  if (!record(value) || value.caseId !== scope.caseId || value.tenantId !== scope.tenantId || !positive(value.revision) || typeof value.eligible !== 'boolean'
    || !(value.blockedReason === null || typeof value.blockedReason === 'string') || typeof value.originalComplaint !== 'string' || !(value.requestNote === null || typeof value.requestNote === 'string')
    || value.paymentSubmission !== false || !Array.isArray(value.lines) || !Array.isArray(value.submissions)) throw new Error('The saved evidence request could not be verified. No new statement can be recorded yet.');
  const lineIds = new Set();
  for (const line of value.lines) {
    if (!record(line) || !id(line.id) || lineIds.has(line.id) || !text(line.name, 1, 300) || !positive(line.ordered) || !Number.isSafeInteger(line.packed) || line.packed < 0 || line.packed > line.ordered || !Number.isSafeInteger(line.unitAmountMinor) || line.unitAmountMinor < 0) throw new Error('The saved order catalogue could not be verified.');
    lineIds.add(line.id);
  }
  const commands = new Set(), submissions = new Set();
  for (const submission of value.submissions) {
    verifyClarificationSubmission(submission);
    if (!lineIds.has(submission.lineId) || commands.has(submission.commandId) || submissions.has(submission.id) || submission.expectedRevision >= value.revision) throw new Error('The saved clarification history could not be matched to this case.');
    commands.add(submission.commandId); submissions.add(submission.id);
  }
  if (value.eligible && (!value.requestNote || !value.lines.length || value.blockedReason !== null)) throw new Error('The case has not established an eligible evidence request.');
  return value;
}

export function findConfirmedClarification(context, command, scope) {
  if (!command) return null;
  const match = context.submissions.find(item => item.commandId === command.commandId);
  return match ? verifyClarificationSubmission(match, { command, userId: scope.userId }) : null;
}

export function verifyClarificationAcknowledgement(value, scope, command) {
  if (!record(value) || value.readbackVerified !== true || typeof value.replayed !== 'boolean') throw new Error('The clarification was not independently confirmed. Keep the exact original request.');
  const context = verifyClarificationContext(value.context, scope);
  const saved = findConfirmedClarification(context, command, scope);
  const submission = verifyClarificationSubmission(value.submission, { command, userId: scope.userId });
  if (!saved || saved.id !== submission.id || saved.actor !== submission.actor || saved.at !== submission.at || !record(value.case)
    || value.case.id !== scope.caseId || !positive(value.case.revision) || value.case.revision < context.revision || value.case.complaint !== context.originalComplaint
    || value.case.paymentSubmissionEnabled !== false) {
    throw new Error('The saved clarification and case could not be matched. The original request is retained for exact recovery.');
  }
  return { context, submission: saved, case: value.case };
}
