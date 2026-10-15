// Playback consumes the append order returned by the saved case API. Sorting by
// timestamps would misorder tied database transactions and clock adjustments.
export function replayEvents(scenario) {
  if (!Array.isArray(scenario?.events)) return [];
  return scenario.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('A saved history entry could not be read. Refresh the case before replaying it.');
    return { ...event, replayIndex: index, replayKey: `${index}:${event.id ?? 'unidentified'}` };
  });
}

export function replayScope(scenario, principalKey, runId) {
  return JSON.stringify([principalKey || 'original-local-demo', runId || 'original', scenario?.id || '']);
}

export function replayStamp(scenario, capabilities = {}) {
  return JSON.stringify([scenario, capabilities.hosted === true, capabilities.separateTestExecutionConfigured === true]);
}

export function captureReplay(scenario, capabilities, scope) {
  const saved = JSON.parse(JSON.stringify(scenario));
  return { scenario: saved, capabilities: JSON.parse(JSON.stringify(capabilities || {})), scope, stamp: replayStamp(scenario, capabilities), events: replayEvents(saved) };
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 4];
export function replayDelay(speed) { return 2500 / (REPLAY_SPEEDS.includes(Number(speed)) ? Number(speed) : 1); }
export function replayPosition(position, count) { return Math.min(Math.max(0, Math.trunc(Number(position)) || 0), Math.max(0, count - 1)); }
export function eventTime(at) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return 'Time not recorded';
  return new Date(at).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
}
export function recordedText(value, fallback = 'Not recorded') { return typeof value === 'string' && value ? value : fallback; }
export function recordedAmount(value) { return Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100) : 'Not recorded'; }
export function replayKeyAction(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target?.closest?.('button, a, input, select, textarea, summary')) return null;
  return ({ ' ': 'toggle', ArrowLeft: 'previous', ArrowRight: 'next', Home: 'first', End: 'last' })[event.key] || null;
}
