const INVESTIGATION_STAGES = new Set(['reception', 'evidence', 'policy']);

export function isManagedInvestigation(record) {
  return Boolean(record?.intakeManaged && INVESTIGATION_STAGES.has(record.stage));
}

export function hasActiveIntake(cases = []) {
  return cases.some(record => isManagedInvestigation(record) && ['ready', 'running'].includes(record.status));
}

// A background read must never replace a newer approval or case transition.
export function mergeBootstrap(current, incoming) {
  if (!current) return incoming;
  const previous = new Map(current.cases.map(record => [record.id, record]));
  const incomingIds = new Set(incoming.cases.map(record => record.id));
  return {
    ...incoming,
    cases: [
      ...current.cases.filter(record => !incomingIds.has(record.id)),
      ...incoming.cases.map(record => (previous.get(record.id)?.revision ?? -1) > record.revision ? previous.get(record.id) : record),
    ],
  };
}

export const intakeStatus = status => ({
  queued: 'Queued', running: 'Investigating', paused: 'Paused',
  'awaiting-review': 'Awaiting your decision', blocked: 'Review needed',
  'awaiting-approval': 'Awaiting reviewer decision', held: 'Review needed',
  'already-resolved': 'Already resolved', error: 'Needs attention',
  'handoff-complete': 'Human decision recorded',
})[status] || 'Saved';
