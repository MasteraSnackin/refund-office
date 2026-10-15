import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Download, Focus, GripVertical, Layers, List, Minus, Move, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { api as baseApi } from './api.js';
import { CaseDownload } from './CaseDownload.jsx';
import { CanvasAssistant } from './CanvasAssistant.jsx';
import { readCanvasVoiceStatus, transcribeCanvasAudio } from './canvas-voice.js';
import { verifyPreparedMiroMap } from './miro-map-view.js';
import { CANVAS_CARD, CANVAS_COLUMNS, CANVAS_STATES, canvasBounds, canvasConnections, canvasEdgePath, caseCanvasScope, filterCaseCanvas, fitCaseCanvas, focusCanvasNode, layoutCaseCanvas, moveCanvasNode, nextCanvasSelection, orderedCanvasNodes, zoomCaseCanvas } from './case-canvas.js';
import './case-canvas.css';

const excerpt = (value, length = 155) => value.length > length ? value.slice(0, length).trimEnd() + '…' : value;

export function CaseCanvas({ scenario, principalKey, apiClient = baseApi, onClose }) {
  const scope = caseCanvasScope(scenario, principalKey, apiClient.runId);
  const current = useRef({ scope, apiClient }); current.current = { scope, apiClient };
  const generation = useRef(0), request = useRef(null), viewport = useRef(null), gesture = useRef(null), nodeRefs = useRef(new Map()), mounted = useRef(true);
  const [state, setState] = useState(null), [reload, setReload] = useState(0), [size, setSize] = useState({ width: 850, height: 520 }), [voiceState, setVoiceState] = useState(null);
  const visible = state?.scope === scope && state?.apiClient === apiClient ? state : null;
  const graph = visible?.board?.provenance;
  const voiceOpen = Boolean(graph && visible?.assistantOpen);
  const sameScope = () => mounted.current && current.current.scope === scope && current.current.apiClient === apiClient;
  const update = change => { if (sameScope()) setState(value => value?.scope === scope && value.apiClient === apiClient ? { ...value, ...change(value) } : value); };

  useEffect(() => {
    mounted.current = true;
    const attempt = ++generation.current, controller = new AbortController(); request.current?.abort(); request.current = controller; gesture.current = null;
    setState({ scope, apiClient, busy: true });
    if (!scope) { setState({ scope, apiClient, error: 'A saved case revision and workspace identity are required to inspect this canvas.' }); return () => { mounted.current = false; controller.abort(); }; }
    apiClient('/cases/' + encodeURIComponent(scenario.id) + '/board-export', { method: 'GET', signal: controller.signal })
      .then(value => verifyPreparedMiroMap(value, scenario))
      .then(board => {
        if (!controller.signal.aborted && attempt === generation.current && sameScope()) {
          const layout = layoutCaseCanvas(board.provenance.nodes);
          setState({ scope, apiClient, board, positions: layout.positions, selectedId: orderedCanvasNodes(board.provenance.nodes)[0]?.id, query: '', mode: 'canvas', zoom: 0.85, pan: { x: 24, y: 20 } });
        }
      })
      .catch(error => { if (!controller.signal.aborted && attempt === generation.current && sameScope()) setState({ scope, apiClient, error: error.message || 'The saved case canvas could not be read.' }); });
    return () => { mounted.current = false; controller.abort(); generation.current++; gesture.current = null; };
  }, [scope, apiClient, reload]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); if (rect.width && rect.height) setSize({ width: rect.width, height: rect.height }); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [graph, visible?.mode]);

  useEffect(() => {
    setVoiceState(null);
    if (!voiceOpen || !scope) return;
    const controller = new AbortController();
    readCanvasVoiceStatus({ scenario, apiClient, signal: controller.signal })
      .then(status => { if (!controller.signal.aborted && sameScope()) setVoiceState({ scope, apiClient, status }); })
      .catch(() => { if (!controller.signal.aborted && sameScope()) setVoiceState({ scope, apiClient, status: { provider: 'elevenlabs', configured: false, available: false, reason: 'Voice input is unavailable in this session. You can still type a question.' } }); });
    return () => controller.abort();
  }, [voiceOpen, scope, apiClient, reload]);

  const transcribeAudio = useCallback(async ({ blob, signal }) => {
    if (!sameScope()) throw new Error('This canvas changed. Record again in the current case.');
    const result = await transcribeCanvasAudio({ scenario, apiClient, blob, signal });
    if (!sameScope()) throw new Error('This canvas changed. The transcript was not applied.');
    return result;
  }, [scope, apiClient, scenario.id, scenario.revision]);

  const selected = graph?.nodes.find(node => node.id === visible.selectedId), selection = graph && filterCaseCanvas(graph, visible.query);
  const connections = selected && canvasConnections(graph, selected.id), bounds = graph && canvasBounds(visible.positions);
  function selectNode(id, { focus = false } = {}) {
    if (!graph?.nodes.some(node => node.id === id)) return;
    update(value => ({ selectedId: id, ...(focus ? focusCanvasNode(value.positions[id], size) : {}) }));
  }
  function changeZoom(multiplier) { update(value => zoomCaseCanvas(value, value.zoom * multiplier, { x: size.width / 2, y: size.height / 2 })); }
  function fit() { if (bounds) update(() => ({ ...fitCaseCanvas(bounds, size), notice: 'Readable fit. Drag the background or use the column buttons to see the remaining records.' })); }
  function resetLayout() { if (graph) update(() => ({ positions: layoutCaseCanvas(graph.nodes).positions, ...fitCaseCanvas(layoutCaseCanvas(graph.nodes), size), notice: 'Original layout restored. Saved case records are unchanged.' })); }
  function jumpColumn(column) {
    const node = orderedCanvasNodes(graph.nodes).find(value => value.column === column);
    if (node) selectNode(node.id, { focus: true });
    else { const index = CANVAS_COLUMNS.findIndex(value => value.id === column); update(value => ({ zoom: 1, pan: { x: 24 - (CANVAS_CARD.padding + index * (CANVAS_CARD.width + CANVAS_CARD.gapX)), y: 20 }, notice: 'No saved records in this column.' })); }
  }
  function startPointer(event, id) {
    if (!graph || !sameScope() || event.button !== 0) return;
    if (!id && event.target.closest?.('button, input, a, select')) return;
    event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId);
    if (id) { selectNode(id); event.currentTarget.focus?.(); }
    gesture.current = { scope, pointerId: event.pointerId, x: event.clientX, y: event.clientY, id, pan: visible.pan, zoom: visible.zoom, position: id && visible.positions[id] };
  }
  function movePointer(event) {
    const active = gesture.current;
    if (!active || active.scope !== scope || active.pointerId !== event.pointerId || !sameScope()) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    if (active.id) update(value => ({ positions: moveCanvasNode({ ...value.positions, [active.id]: active.position }, active.id, dx / active.zoom, dy / active.zoom) }));
    else update(() => ({ pan: { x: active.pan.x + dx, y: active.pan.y + dy } }));
  }
  function endPointer(event) { if (gesture.current?.pointerId === event.pointerId) { gesture.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }
  function nodeKeyboard(event, node) {
    if (!sameScope() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey && visible.mode === 'canvas') {
      const delta = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
      update(value => ({ positions: moveCanvasNode(value.positions, node.id, ...delta) }));
    } else {
      const candidates = visible.mode === 'list' && selection.term ? graph.nodes.filter(value => selection.matches.has(value.id)) : graph.nodes;
      const next = nextCanvasSelection(candidates, node.id, ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
      if (next) { selectNode(next, { focus: visible.mode === 'canvas' }); nodeRefs.current.get(next)?.focus?.(); }
    }
  }
  function viewportKeyboard(event) {
    if (event.target !== event.currentTarget) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const [x, y] = { ArrowLeft: [100, 0], ArrowRight: [-100, 0], ArrowUp: [0, 100], ArrowDown: [0, -100] }[event.key];
      update(value => ({ pan: { x: value.pan.x + x, y: value.pan.y + y } }));
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.2); }
    else if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.2); }
    else if (event.key === 'Home') { event.preventDefault(); fit(); }
  }
  const currentTitle = selected && CANVAS_COLUMNS.find(column => column.id === selected.column)?.title;
  function relationshipGroup(label, values, Icon) {
    return <section className="case-canvas-relations"><h4><Icon size={14} aria-hidden="true" />{label} <span>{values.length}</span></h4>{values.length ? <ul>{values.map(({ edge, node }) => <li key={edge.id}><button type="button" onClick={() => selectNode(node.id, { focus: true })}><span>{edge.label}</span><strong>{node.title}</strong><small>{CANVAS_STATES[edge.state]}</small></button></li>)}</ul> : <p>No saved connection in this direction.</p>}</section>;
  }

  return <section className="case-canvas" aria-label={'Case canvas for ' + (scenario.caseId || 'saved case')} onKeyDown={event => { if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="case-canvas-header"><div className="case-canvas-mark"><Layers size={23} aria-hidden="true" /></div><div><p className="case-canvas-eyebrow">CASE CANVAS</p><h2>{scenario.caseId} <span>Evidence to decision</span></h2><p>Saved revision {scenario.revision} · A read-only map of this case</p></div><div className="case-canvas-header-actions"><button type="button" onClick={() => { if (sameScope()) setReload(value => value + 1); }} disabled={visible?.busy} aria-label="Refresh saved case canvas"><RefreshCw size={17} aria-hidden="true" /><span>Refresh</span></button>{onClose && <button type="button" className="case-canvas-close" onClick={onClose} aria-label="Close case canvas"><X size={22} aria-hidden="true" /></button>}</div></header>
    <p className="case-canvas-boundary">A recommendation is not approval. This view cannot approve, submit or publish. Moving cards only changes this view.</p>
    {visible?.error && <div className="case-canvas-message" role="alert"><strong>Canvas unavailable</strong><p>{visible.error}</p><button type="button" onClick={() => { if (sameScope()) setReload(value => value + 1); }}>Read saved case again</button></div>}
    {(!visible || visible.busy) && <div className="case-canvas-message" role="status"><Layers size={28} aria-hidden="true" /><p>Reading the saved sources and relationships…</p></div>}
    {graph && <>
      <div className="case-canvas-toolbar"><label className="case-canvas-search"><Search size={17} aria-hidden="true" /><span className="case-canvas-sr">Search saved records and references</span><input type="search" placeholder="Search records or references" value={visible.query} onChange={event => { const query = event.target.value; update(() => ({ query })); }} />{visible.query && <button type="button" aria-label="Clear canvas search" onClick={() => update(() => ({ query: '' }))}><X size={15} aria-hidden="true" /></button>}</label><div className="case-canvas-mode" aria-label="Canvas display"><button type="button" aria-pressed={visible.mode === 'canvas'} onClick={() => update(() => ({ mode: 'canvas' }))}><Layers size={15} aria-hidden="true" />Canvas</button><button type="button" aria-pressed={visible.mode === 'list'} onClick={() => update(() => ({ mode: 'list' }))}><List size={15} aria-hidden="true" />List</button></div><button type="button" className="case-canvas-assistant-toggle" aria-label="Toggle case assistant" aria-pressed={Boolean(visible.assistantOpen)} onClick={() => update(value => ({ assistantOpen: !value.assistantOpen }))}>{visible.assistantOpen ? 'Record inspector' : 'Ask this case'}</button><p className="case-canvas-count" role="status">{selection.term ? `${selection.matches.size} of ${graph.nodes.length} records match` : `${graph.nodes.length} records · ${graph.edges.length} connections`}</p></div>
      <div className="case-canvas-body"><div className="case-canvas-workspace">
        <nav className="case-canvas-columns" aria-label="Go to case stage">{CANVAS_COLUMNS.map((column, index) => <button key={column.id} type="button" className={'case-canvas-column-link ' + column.id} onClick={() => { if (visible.mode === 'list') update(() => ({ mode: 'canvas' })); jumpColumn(column.id); }}><span>{index + 1}</span>{column.title}<small>{graph.nodes.filter(node => node.column === column.id).length}</small></button>)}</nav>
        {visible.mode === 'canvas' ? <div className="case-canvas-viewport" ref={viewport} tabIndex={0} aria-label="Spatial case map. Drag the background to pan. Arrow keys pan; plus and minus zoom; Home fits a readable view." onKeyDown={viewportKeyboard} onPointerDown={event => startPointer(event)} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}>
          <div className="case-canvas-plane" style={{ width: bounds.width, height: bounds.height, transform: `translate(${visible.pan.x}px, ${visible.pan.y}px) scale(${visible.zoom})` }}>
            {CANVAS_COLUMNS.map((column, index) => <div className={'case-canvas-lane ' + column.id} key={column.id} style={{ left: CANVAS_CARD.padding - 12 + index * (CANVAS_CARD.width + CANVAS_CARD.gapX), width: CANVAS_CARD.width + 24, height: bounds.height - 32 }}><strong>{column.title}</strong><small>{column.note}</small></div>)}
            <svg className="case-canvas-edges" width={bounds.width} height={bounds.height} aria-hidden="true"><defs><marker id="case-canvas-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="currentColor" /></marker></defs>{graph.edges.map(edge => { const path = canvasEdgePath(visible.positions[edge.from], visible.positions[edge.to]), connected = edge.from === visible.selectedId || edge.to === visible.selectedId, dim = selection.term && !selection.edges.has(edge.id); return <g key={edge.id} className={'case-canvas-edge' + (connected ? ' is-selected' : '') + (dim ? ' is-dimmed' : '')}><path d={path.d} markerEnd="url(#case-canvas-arrow)" /><g className="case-canvas-edge-label" transform={`translate(${path.x}, ${path.y})`}><rect x="-110" y="-11" width="220" height="22" rx="5" /><text textAnchor="middle" dy="4">{excerpt(edge.label, 37)}</text></g></g>; })}</svg>
            {orderedCanvasNodes(graph.nodes).map(node => <button key={node.id} type="button" ref={element => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }} className={'case-canvas-card ' + node.column + (visible.selectedId === node.id ? ' is-selected' : '') + (selection.term && selection.matches.has(node.id) ? ' is-match' : '') + (selection.term && !selection.matches.has(node.id) && !selection.related.has(node.id) ? ' is-dimmed' : '')} style={{ left: visible.positions[node.id].x, top: visible.positions[node.id].y, width: CANVAS_CARD.width, height: CANVAS_CARD.height }} aria-label={`${node.title}. ${CANVAS_STATES[node.state]}. Select to inspect the saved text and connections.`} aria-pressed={visible.selectedId === node.id} onClick={() => selectNode(node.id)} onPointerDown={event => { event.stopPropagation(); startPointer(event, node.id); }} onPointerMove={event => { event.stopPropagation(); movePointer(event); }} onPointerUp={endPointer} onPointerCancel={endPointer} onKeyDown={event => nodeKeyboard(event, node)}><span className="case-canvas-card-top"><span className={'case-canvas-state ' + node.state}>{CANVAS_STATES[node.state]}</span><GripVertical size={16} aria-hidden="true" /></span><strong>{node.title}</strong><span className="case-canvas-card-excerpt">{excerpt(node.text)}</span><span className="case-canvas-card-bottom">{node.refs.length} {node.refs.length === 1 ? 'reference' : 'references'}<span>{graph.edges.filter(edge => edge.from === node.id || edge.to === node.id).length} connections</span></span></button>)}
          </div>
          <div className="case-canvas-minimap" aria-hidden="true"><svg viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="xMidYMid meet">{graph.edges.map(edge => { const from = visible.positions[edge.from], to = visible.positions[edge.to]; return <line key={edge.id} x1={from.x + CANVAS_CARD.width / 2} y1={from.y + CANVAS_CARD.height / 2} x2={to.x + CANVAS_CARD.width / 2} y2={to.y + CANVAS_CARD.height / 2} />; })}{graph.nodes.map(node => <rect key={node.id} className={node.column + (node.id === visible.selectedId ? ' is-selected' : '')} x={visible.positions[node.id].x} y={visible.positions[node.id].y} width={CANVAS_CARD.width} height={CANVAS_CARD.height} rx="12" />)}<rect className="case-canvas-minimap-window" x={-visible.pan.x / visible.zoom} y={-visible.pan.y / visible.zoom} width={size.width / visible.zoom} height={size.height / visible.zoom} /></svg></div>
        </div> : <div className="case-canvas-list" aria-label="Saved case records">{CANVAS_COLUMNS.map(column => { const records = graph.nodes.filter(node => node.column === column.id && (!selection.term || selection.matches.has(node.id))); return <section key={column.id}><h3>{column.title} <span>{records.length}</span></h3>{records.length ? records.map(node => <button key={node.id} type="button" ref={element => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }} className={visible.selectedId === node.id ? 'is-selected' : ''} aria-pressed={visible.selectedId === node.id} onClick={() => selectNode(node.id)} onKeyDown={event => nodeKeyboard(event, node)}><span className={'case-canvas-state ' + node.state}>{CANVAS_STATES[node.state]}</span><strong>{node.title}</strong><span>{excerpt(node.text, 235)}</span></button>) : <p>{selection.term ? 'No matching records in this column.' : 'No saved records in this column.'}</p>}</section>; })}</div>}
        <div className="case-canvas-controls">{visible.mode === 'canvas' ? <><div className="case-canvas-zoom"><button type="button" onClick={() => changeZoom(1 / 1.2)} aria-label="Zoom out" disabled={visible.zoom <= 0.45}><Minus size={16} aria-hidden="true" /></button><output aria-label="Canvas zoom">{Math.round(visible.zoom * 100)}%</output><button type="button" onClick={() => changeZoom(1.2)} aria-label="Zoom in" disabled={visible.zoom >= 1.8}><Plus size={16} aria-hidden="true" /></button></div><button type="button" onClick={fit}><Move size={15} aria-hidden="true" />Fit readable</button><button type="button" onClick={() => { if (selected) selectNode(selected.id, { focus: true }); }} disabled={!selected}><Focus size={15} aria-hidden="true" />Focus selected</button><button type="button" onClick={resetLayout}><RotateCcw size={15} aria-hidden="true" />Reset layout</button></> : <p>Choose a record to read its saved text and follow its connections.</p>}</div>
        <p className="case-canvas-help">{visible.notice || (visible.mode === 'canvas' ? 'Drag cards to arrange; drag the background to pan. On a card: arrows select, Shift + arrows move. Layout changes are not saved.' : 'Arrow keys on a record select the next or previous saved record.')}</p>
      </div><aside className={'case-canvas-inspector' + (visible.assistantOpen ? ' is-assistant' : '')} aria-label={visible.assistantOpen ? 'Case assistant' : 'Selected record inspector'}>{visible.assistantOpen ? <CanvasAssistant key={scope + ':' + reload} map={visible.board} identityKey={scope + ':' + reload} selectedNodeId={visible.selectedId} onSelectNode={id => selectNode(id, { focus: true })} transcribeAudio={transcribeAudio} voiceStatus={voiceState?.scope === scope && voiceState?.apiClient === apiClient ? voiceState.status : { provider: 'elevenlabs', configured: false, available: false, reason: 'Checking voice input availability…' }} /> : selected && <><p className="case-canvas-eyebrow">RECORD INSPECTOR <span>{currentTitle}</span></p><h3>{selected.title}</h3><span className={'case-canvas-state ' + selected.state}>{CANVAS_STATES[selected.state]}</span><section className="case-canvas-saved-text"><h4>Saved map text</h4><p>{selected.text || 'No text is included in this saved map record.'}</p>{selected.excerpt && <small>This map contains an excerpt. Use the saved case export for the complete underlying record.</small>}</section><section className="case-canvas-references"><h4>Saved references <span>{selected.refs.length}</span></h4>{selected.refs.length ? <dl>{selected.refs.map((ref, index) => <div key={index}><dt>{ref.type}</dt><dd>{ref.id}</dd></div>)}</dl> : <p>No reference identifiers are included.</p>}<small>Source references are text only. They are never opened by this canvas.</small></section>{selected.links.length > 0 && <section className="case-canvas-record-links"><h4>Supported case files</h4><p>These retrieve the current saved case and may contain a later revision.</p>{selected.links.map((link, index) => <CaseDownload key={index} runId={apiClient.runId} href={link.path} className="case-canvas-record-download"><Download size={14} aria-hidden="true" />{link.label}</CaseDownload>)}</section>}{relationshipGroup('Incoming', connections.incoming, ArrowDownLeft)}{relationshipGroup('Outgoing', connections.outgoing, ArrowUpRight)}</>}</aside></div>
      <footer className="case-canvas-footer"><span>{visible.board.synthetic === true ? 'Synthetic records' : 'Source data mode not established'} · Saved revision {visible.board.revision} · No board publication</span><details><summary>Map limits and identity</summary><ul><li>Identity scope: {visible.board.identityScope || 'Not established by this saved map.'}</li>{visible.board.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details></footer>
    </>}
  </section>;
}
