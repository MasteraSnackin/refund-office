export const CANVAS_COLUMNS = [
  { id: 'sources', title: 'Sources', note: 'Original and later records' },
  { id: 'investigation', title: 'Investigation', note: 'Saved findings and recommendation' },
  { id: 'policy', title: 'Policy', note: 'Checks saved with this case' },
  { id: 'decision', title: 'Human decision', note: 'Waiting or recorded review' },
  { id: 'destinations', title: 'Outputs', note: 'Saved results and available files' },
];

export const CANVAS_CARD = { width: 256, height: 174, gapX: 64, gapY: 28, padding: 32, heading: 70 };
export const CANVAS_STATES = { saved: 'Saved record', waiting: 'Waiting', available: 'Available locally', unverified: 'Not verified' };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function caseCanvasScope(scenario, principalKey, runId) {
  if (typeof principalKey !== 'string' || !principalKey || typeof scenario?.id !== 'string' || !scenario.id
    || typeof scenario.caseId !== 'string' || !scenario.caseId || !Number.isSafeInteger(scenario.revision) || scenario.revision < 0) return '';
  return JSON.stringify([principalKey, runId ?? null, scenario.id, scenario.caseId, scenario.revision]);
}

export function layoutCaseCanvas(nodes) {
  const positions = Object.create(null), columns = CANVAS_COLUMNS.map((column, columnIndex) => {
    const records = nodes.filter(node => node.column === column.id);
    const x = CANVAS_CARD.padding + columnIndex * (CANVAS_CARD.width + CANVAS_CARD.gapX);
    records.forEach((node, index) => { positions[node.id] = { x, y: CANVAS_CARD.padding + CANVAS_CARD.heading + index * (CANVAS_CARD.height + CANVAS_CARD.gapY) }; });
    return { ...column, x, count: records.length };
  });
  return { positions, columns, ...canvasBounds(positions) };
}

export function canvasBounds(positions) {
  const values = Object.values(positions);
  return {
    width: Math.max(CANVAS_COLUMNS.length * (CANVAS_CARD.width + CANVAS_CARD.gapX), ...values.map(point => point.x + CANVAS_CARD.width + CANVAS_CARD.padding)),
    height: Math.max(500, ...values.map(point => point.y + CANVAS_CARD.height + CANVAS_CARD.padding)),
  };
}

export function moveCanvasNode(positions, id, dx, dy) {
  if (!Object.hasOwn(positions, id) || ![dx, dy].every(Number.isFinite)) return positions;
  return { ...positions, [id]: { x: clamp(positions[id].x + dx, 16, 10000), y: clamp(positions[id].y + dy, CANVAS_CARD.heading + 16, 10000) } };
}

export function filterCaseCanvas(graph, query = '') {
  const term = query.trim().toLocaleLowerCase('en-GB');
  const matches = new Set(graph.nodes.filter(node => !term || [node.title, node.text, node.kind, CANVAS_STATES[node.state], CANVAS_COLUMNS.find(column => column.id === node.column)?.title, ...node.refs.map(ref => `${ref.type} ${ref.id}`)].join('\n').toLocaleLowerCase('en-GB').includes(term)).map(node => node.id));
  if (term) for (const edge of graph.edges) if (edge.label.toLocaleLowerCase('en-GB').includes(term)) { matches.add(edge.from); matches.add(edge.to); }
  const related = new Set(), edges = new Set();
  for (const edge of graph.edges) if (!term || matches.has(edge.from) || matches.has(edge.to)) {
    edges.add(edge.id);
    if (!matches.has(edge.from)) related.add(edge.from);
    if (!matches.has(edge.to)) related.add(edge.to);
  }
  return { term, matches, related, edges };
}

export function canvasConnections(graph, id) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return {
    incoming: graph.edges.filter(edge => edge.to === id).map(edge => ({ edge, node: nodes.get(edge.from) })),
    outgoing: graph.edges.filter(edge => edge.from === id).map(edge => ({ edge, node: nodes.get(edge.to) })),
  };
}

export function orderedCanvasNodes(nodes) {
  return CANVAS_COLUMNS.flatMap(column => nodes.filter(node => node.column === column.id));
}

export function nextCanvasSelection(nodes, selectedId, direction = 1) {
  const ordered = orderedCanvasNodes(nodes);
  if (!ordered.length) return null;
  const index = ordered.findIndex(node => node.id === selectedId);
  if (index < 0) return (direction < 0 ? ordered.at(-1) : ordered[0]).id;
  return ordered[(index + (direction < 0 ? -1 : 1) + ordered.length) % ordered.length].id;
}

// A readable fit deliberately leaves room to pan rather than shrinking evidence to tiny text.
export function fitCaseCanvas(bounds, viewport) {
  const zoom = clamp(Math.min((viewport.width - 48) / bounds.width, (viewport.height - 48) / bounds.height), 0.85, 1);
  return { zoom, pan: { x: 24, y: 20 } };
}

export function zoomCaseCanvas(view, nextZoom, point) {
  const zoom = clamp(nextZoom, 0.45, 1.8), ratio = zoom / view.zoom;
  return { zoom, pan: { x: point.x - (point.x - view.pan.x) * ratio, y: point.y - (point.y - view.pan.y) * ratio } };
}

export function focusCanvasNode(position, viewport, zoom = 1) {
  return { zoom, pan: { x: viewport.width / 2 - (position.x + CANVAS_CARD.width / 2) * zoom, y: viewport.height / 2 - (position.y + CANVAS_CARD.height / 2) * zoom } };
}

export function canvasEdgePath(from, to) {
  const forward = to.x >= from.x, startX = from.x + (forward ? CANVAS_CARD.width : 0), endX = to.x + (forward ? 0 : CANVAS_CARD.width);
  const startY = from.y + CANVAS_CARD.height / 2, endY = to.y + CANVAS_CARD.height / 2;
  const bend = Math.max(40, Math.abs(endX - startX) * 0.45);
  return { d: `M ${startX} ${startY} C ${startX + (forward ? bend : -bend)} ${startY}, ${endX - (forward ? bend : -bend)} ${endY}, ${endX} ${endY}`, x: (startX + endX) / 2, y: (startY + endY) / 2 };
}
