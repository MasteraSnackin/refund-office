const states = new Set(['saved', 'waiting', 'available', 'unverified']);
const columns = new Set(['sources', 'investigation', 'policy', 'decision', 'destinations']);
const string = value => typeof value === 'string';
const invalid = () => { throw new Error('The prepared map could not be matched to this saved case. Refresh the case and inspect it again.'); };

export function verifyPreparedMiroMap(value, scenario) {
  if (value?.format !== 'refund-office-case-board' || value.mode !== 'local-export' || value.target !== 'miro' || value.importReady !== false
    || value.caseId !== scenario.caseId || value.caseRecordId !== scenario.id || value.revision !== scenario.revision || value.publication?.prepared !== true || value.publication.published !== false || value.publication.provider !== 'miro'
    || value.provenance?.schemaVersion !== 1 || !Array.isArray(value.provenance.nodes) || !value.provenance.nodes.length || value.provenance.nodes.length > 100
    || !Array.isArray(value.provenance.edges) || value.provenance.edges.length > 300 || !Array.isArray(value.limitations) || !value.limitations.every(string)) invalid();
  const ids = new Set(), edgeIds = new Set(), base = `/api/cases/${encodeURIComponent(scenario.id)}`;
  for (const node of value.provenance.nodes) {
    if (!node || !string(node.id) || !node.id || ids.has(node.id) || !string(node.kind) || !string(node.title) || !string(node.text) || !states.has(node.state) || !columns.has(node.column)
      || !Array.isArray(node.refs) || !node.refs.every(ref => ref && string(ref.type) && string(ref.id))
      || !Array.isArray(node.links) || !node.links.every(link => link && string(link.label) && [base, `${base}/export`, `${base}/report`, `${base}/board-export`].includes(link.path))) invalid();
    ids.add(node.id);
  }
  for (const edge of value.provenance.edges) {
    if (!edge || !string(edge.id) || !edge.id || edgeIds.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) || !string(edge.label) || !states.has(edge.state)) invalid();
    edgeIds.add(edge.id);
  }
  return value;
}

export function miroReadbackSummary(value = {}) {
  const records = Array.isArray(value.records) ? value.records : [];
  const cards = Array.isArray(value.items) ? value.items.filter(item => item.itemKind !== 'connector') : records.filter(row => row.action?.startsWith('miro-card-') && row.itemKind !== 'connector');
  const connectors = Array.isArray(value.connectors) ? value.connectors : Array.isArray(value.items) ? value.items.filter(item => item.itemKind === 'connector') : records.filter(row => row.itemKind === 'connector' || row.action?.startsWith('miro-connector-'));
  const parent = records.find(row => row.action === 'miro');
  const counts = value.counts || parent?.counts;
  const verifiedNotes = cards.filter(row => row.verified === true).length, verifiedConnectors = connectors.filter(row => row.verified === true).length;
  const complete = (value.verified === true || parent?.state === 'succeeded' && parent.verified === true)
    && Number.isSafeInteger(counts?.notes) && counts.notes > 0 && Number.isSafeInteger(counts?.connectors) && counts.connectors >= 0
    && verifiedNotes === counts.notes && verifiedConnectors === counts.connectors;
  return { complete, verifiedNotes, verifiedConnectors, expectedNotes: counts?.notes, expectedConnectors: counts?.connectors };
}
