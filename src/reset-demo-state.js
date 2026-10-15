export const RESET_PENDING_KEY = 'refund-office:pending-demo-reset:v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const pack = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
export const validDemoRun = value => value && UUID.test(value.id || '') && pack(value.packId) && typeof value.resetSupported === 'boolean';
export function canResetDemo(access) {
  return access?.mode === 'local-rehearsal' && access.authenticated === true && access.session?.role === 'reviewer'
    && UUID.test(access.session.userId || '') && UUID.test(access.workspace?.id || '')
    && access.demoRun?.resetSupported === true && UUID.test(access.demoRun.id || '') && pack(access.demoRun.packId);
}
export function readResetCommand(storage) {
  const raw = storage.getItem(RESET_PENDING_KEY); if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || !UUID.test(value.commandId || '') || !UUID.test(value.sourceRunId || '') || !UUID.test(value.tenantId || '') || !UUID.test(value.userId || '') || !pack(value.packId)
      || !(value.targetRunId === null || UUID.test(value.targetRunId || '') && value.targetRunId !== value.sourceRunId)
      || Object.keys(value).some(key => !['schemaVersion', 'commandId', 'sourceRunId', 'tenantId', 'userId', 'packId', 'targetRunId'].includes(key))) throw Error('Invalid command');
    return value;
  } catch { throw new Error('The saved reset request could not be read safely. Another reset is blocked; keep the saved browser data and inspect this rehearsal.'); }
}
export function prepareResetCommand(storage, access, createId = () => crypto.randomUUID()) {
  if (!canResetDemo(access)) throw new Error('A current reviewer session in the reset-enabled local rehearsal is required.');
  const previous = readResetCommand(storage); if (previous) return previous;
  const command = { schemaVersion: 1, commandId: createId(), sourceRunId: access.demoRun.id, tenantId: access.workspace.id, userId: access.session.userId, packId: access.demoRun.packId, targetRunId: null };
  if (!UUID.test(command.commandId || '')) throw new Error('A stable reset reference could not be prepared.');
  storage.setItem(RESET_PENDING_KEY, JSON.stringify(command));
  if (readResetCommand(storage)?.commandId !== command.commandId) throw new Error('The reset could not be saved for a safe retry. No reset was requested.');
  return command;
}
export function verifyResetReceipt(value, command) {
  if (!value || typeof value !== 'object' || value.commandId !== command.commandId || value.sourceRunId !== command.sourceRunId || value.packId !== command.packId
    || !UUID.test(value.targetRunId || '') || value.targetRunId === command.sourceRunId || command.targetRunId && value.targetRunId !== command.targetRunId
    || !['switching', 'ready', 'failed', 'unresolved'].includes(value.status) || typeof value.checkpointConfirmed !== 'boolean' || typeof value.message !== 'string'
    || value.status === 'ready' && value.checkpointConfirmed !== true) throw new Error('The reset result could not be matched to the original request. Keep that request and check its saved status.');
  return value;
}
export function rememberResetTarget(storage, command, receipt) {
  const saved = { ...command, targetRunId: receipt.targetRunId };
  storage.setItem(RESET_PENDING_KEY, JSON.stringify(saved));
  if (readResetCommand(storage)?.targetRunId !== receipt.targetRunId) throw new Error('The reset target could not be saved safely. Check the original reset status.');
  return saved;
}
export function completeResetCommand(storage, command) {
  const saved = readResetCommand(storage);
  if (!saved || saved.commandId !== command.commandId) throw new Error('The pending reset changed. Check its saved status before continuing.');
  storage.removeItem(RESET_PENDING_KEY);
  if (storage.getItem(RESET_PENDING_KEY) !== null) throw new Error('The reset is ready, but its browser recovery record could not be cleared. Check the saved status again.');
}
