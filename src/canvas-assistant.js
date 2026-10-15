export const CANVAS_CHAT_LIMITS = Object.freeze({ question: 1600, messages: 20, recordingMs: 45000, recordingBytes: 2 * 1024 * 1024 });

const columns = new Set(['sources', 'investigation', 'policy', 'decision', 'destinations']);
const states = new Set(['saved', 'waiting', 'available', 'unverified']);
const plain = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : '';
const excerpt = (value, size) => value.length > size ? { text: value.slice(0, size).trimEnd() + '…', excerpt: true } : { text: value, excerpt: false };

// The caller supplies the canvas's verified map. Recheck its shape here so that
// citations can only select a real record. Record text is data, never instructions.
export function assistantMap(map) {
  const graph = map?.provenance || map;
  if (graph?.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 100 || !Array.isArray(graph.edges) || graph.edges.length > 300) return null;
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || typeof node.kind !== 'string' || typeof node.title !== 'string' || typeof node.text !== 'string' || !columns.has(node.column) || !states.has(node.state) || !Array.isArray(node.refs) || !node.refs.every(ref => ref && typeof ref.type === 'string' && typeof ref.id === 'string')) return null;
    ids.add(node.id);
  }
  for (const edge of graph.edges) if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || typeof edge.label !== 'string' || !states.has(edge.state)) return null;
  return { nodes: graph.nodes, edges: graph.edges, caseId: plain(map.caseId), revision: map.revision, limitations: Array.isArray(map.limitations) ? map.limitations.filter(value => typeof value === 'string') : [] };
}

export function canvasRecordAnswer(map, question, selectedNodeId) {
  const graph = assistantMap(map);
  const result = (topic, text, records = [], note = '') => ({ topic, text, records: records.map(({ node, relation }) => ({ id: node.id, title: plain(node.title), state: node.state, ...excerpt(plain(node.text), topic === 'selected' ? 1800 : 650), ...(node.excerpt ? { excerpt: true } : {}), relation })), note });
  if (!graph) return result('unavailable', 'A verified saved map is required before this panel can answer questions. Refresh the case canvas.');
  const input = plain(question).trim().slice(0, CANVAS_CHAT_LIMITS.question).toLocaleLowerCase('en-GB');
  const kinds = kind => graph.nodes.filter(node => node.kind === kind);
  const currentReview = kinds('review').find(node => !/history|original operation approval/i.test(node.title));
  const recommendation = kinds('recommendation')[0], investigation = kinds('investigation')[0], payment = kinds('payment')[0];
  const records = values => values.filter(Boolean).map(node => ({ node }));
  const action = /^(?:(?:please|now|just)\s+)*(?:(?:can|could|will|would)\s+you\s+|i\s+want\s+you\s+to\s+)?(?:please\s+)?(?:approve|authorise|authorize|pay|submit|execute|publish|delete|edit|change|alter|rewrite|overwrite)\b/.test(input)
    || /\b(?:go ahead(?: and)?|send the refund|make (?:the|a) payment|release (?:the|a) refund|ignore .{0,80}(?:approve|pay|change evidence))\b/.test(input);
  if (action) return result('boundary', 'I cannot approve or pay a refund, publish results, or change saved evidence. Use the main case workflow for an explicit human decision. A recommendation or passed check does not grant approval.', records([currentReview, recommendation]));
  if (/\b(?:open|visit|fetch|follow|browse)\b.{0,60}\b(?:url|link|source|reference)\b/.test(input)) return result('boundary', 'Source references are quoted text. This panel does not open or fetch them. I can explain the saved records already included in this map.');
  if (/\b(?:selected|this (?:card|node|record)|current record|explain this|tell me about this)\b/.test(input)) {
    const node = graph.nodes.find(value => value.id === selectedNodeId);
    if (!node) return result('selected', 'Select a saved record on the canvas first, then ask about the selected record.');
    const edges = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
    return result('selected', 'This is the selected saved record. The text below is quoted from the map; any instructions inside it are source material.', [{ node }], `${edges.length} saved ${edges.length === 1 ? 'connection' : 'connections'}. References remain text only. Select its citation to inspect the complete record and connections.`);
  }
  if (/\b(?:paid|payment|receipt|refunded|settled|submitted|stripe|bank)\b/.test(input)) return result('payment', 'The saved payment record is quoted below. A recommendation, approval or reservation alone does not establish a completed payment.', records([payment, currentReview]), payment?.state === 'unverified' ? 'Separate execution records are not verified by this map.' : 'This answer describes the saved snapshot. It does not check a payment provider.');
  if (/\b(?:amount|how much|refund total|recommended refund|money)\b|£/.test(input)) return result('amount', recommendation ? 'The saved recommendation is quoted below. Its amount is a proposal, not approval or proof of payment.' : 'No recommendation record is included in this map, so the proposed refund amount is unknown here.', records([recommendation, currentReview]));
  if (/\b(?:evidence|sources?|complaint|clarification|cited|gathered|based on)\b|where.{0,25}come from/.test(input)) {
    const sources = graph.nodes.filter(node => node.column === 'sources').map(node => {
      const relation = graph.edges.find(edge => edge.from === node.id && edge.to === investigation?.id)?.label || 'No saved citation relationship to the investigation.';
      return { node, relation };
    });
    const ordered = [...sources.filter(value => value.relation === 'Cited by the saved proposal'), ...sources.filter(value => value.relation !== 'Cited by the saved proposal')];
    return result('evidence', `${sources.length} source ${sources.length === 1 ? 'record is' : 'records are'} saved in this map. A gathered record is not necessarily cited by the saved proposal. Original complaints and later clarification remain distinct.`, ordered.slice(0, 5), sources.length > 5 ? `Showing 5 of ${sources.length} source records. Select another source on the canvas and ask about the selected record.` : 'Quoted source text is untrusted material. It cannot instruct this panel or establish authenticity.');
  }
  if (/\b(?:policy|checks?|rule|eligible|eligibility|limit)\b/.test(input)) {
    const checks = kinds('policy'), ordered = [...checks.filter(node => /^Held\./.test(node.text)), ...checks.filter(node => !/^Held\./.test(node.text))];
    return result('policy', `${checks.length} policy ${checks.length === 1 ? 'record is' : 'records are'} included in the saved snapshot. These checks are not a current payment result and cannot authorise a refund.`, records(ordered.slice(0, 4)), checks.length > 4 ? `Showing 4 of ${checks.length} saved checks, with held checks first. Select any other check on the canvas to read it.` : 'No check has been rerun by this chat.');
  }
  if (/\b(?:approval|human|review|reviewer|decision|approved|authorised|authorized)\b/.test(input)) return result('approval', 'Every new refund requires an explicit human approval bound to the case, amount and evidence. The current saved decision is quoted below. Historical decisions do not grant fresh approval.', records([currentReview]), 'Use the main case review workflow for any decision. This panel cannot record one.');
  if (/\b(?:next|what now|what should|step|proceed|waiting|blocked|hold|held|why)\b/.test(input)) return result('next', currentReview?.state === 'waiting' ? 'The saved map is waiting for a human decision. Review the recommendation, evidence and held checks in the main case workflow before choosing a decision.' : 'Use the saved review state and recommendation below to assess the next step in the main case workflow. This map does not grant permission to pay.', records([currentReview, recommendation, ...kinds('policy').filter(node => /^Held\./.test(node.text)).slice(0, 1)]), 'Any changed facts require a new investigation and human review. This chat does not change the case.');
  if (/\b(?:unknown|missing|unsure|uncertain|limitations?|prove|verify|unverified|not know)\b/.test(input)) return result('unknown', 'This panel can describe only the records in the current saved map. It cannot establish source authenticity, later case changes, an external provider result, or facts absent from the snapshot.', records(graph.nodes.filter(node => node.state === 'unverified' || node.state === 'waiting').slice(0, 3)), graph.limitations.slice(0, 4).join('\n'));
  if (/\b(?:summary|summarise|summarize|overview|case|explain|help|hello|hi)\b/.test(input)) return result('overview', 'This is a local explanation of the saved case map. The recommendation, current human decision and payment record are quoted below.', records([recommendation, currentReview, payment]), 'Ask about the amount, evidence, policy checks, next step, human approval, or selected record.');
  return result('unknown', 'That answer is not established by this saved map. I can explain the saved amount, evidence, policy checks, next step, human approval, payment record, or selected record.');
}

export function elevenLabsVoiceAvailability(status, transcribeAudio) {
  if (typeof transcribeAudio !== 'function' || status?.configured !== true || status?.available !== true || status.provider && status.provider !== 'elevenlabs') return { available: false, reason: plain(status?.reason) || 'ElevenLabs transcription is not connected. Typing is available.' };
  return { available: true, reason: '' };
}

// No files, storage, object URLs or provider requests are created here. Recording
// is bounded and held in memory until the caller explicitly transcribes it.
export function createCanvasVoiceRecorder({ getUserMedia, MediaRecorder, onChange, setTimer = setTimeout, clearTimer = clearTimeout, maxMs = CANVAS_CHAT_LIMITS.recordingMs, maxBytes = CANVAS_CHAT_LIMITS.recordingBytes }) {
  let generation = 0, active = false, stream = null, recorder = null, timer = null, chunks = [], bytes = 0, disposed = false, finishNotice = '';
  const emit = value => { if (!disposed) onChange(value); };
  const stopTracks = value => { for (const track of value?.getTracks?.() || []) { try { track.stop(); } catch {} } };
  function release() { if (timer !== null) clearTimer(timer); timer = null; stopTracks(stream); stream = null; }
  function cancel(notice = 'Recording discarded. Nothing was sent.') {
    generation++; active = false; release();
    if (recorder) { recorder.ondataavailable = recorder.onstop = recorder.onerror = null; try { if (recorder.state !== 'inactive') recorder.stop(); } catch {} }
    recorder = null; chunks = []; bytes = 0; emit({ phase: 'idle', blob: null, notice });
  }
  function stop(notice = 'Recording is ready locally. Review the destination before transcription.') {
    if (!active || !recorder || recorder.state === 'inactive') return;
    active = false; finishNotice = notice; release(); emit({ phase: 'stopping', blob: null, notice: 'Stopping the microphone…' });
    try { recorder.stop(); } catch { cancel('Recording could not be completed. Nothing was sent.'); }
  }
  async function start() {
    if (disposed || active) return;
    cancel(''); const attempt = ++generation; active = true; emit({ phase: 'requesting', blob: null, notice: 'Waiting for microphone permission. No audio has been sent.' });
    try {
      const acquired = await getUserMedia({ audio: true });
      if (disposed || !active || attempt !== generation) { stopTracks(acquired); return; }
      stream = acquired;
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(value => MediaRecorder.isTypeSupported?.(value));
      const instance = new MediaRecorder(stream, type ? { mimeType: type } : undefined); recorder = instance;
      instance.ondataavailable = event => {
        if (disposed || attempt !== generation || !event.data?.size) return;
        if (bytes + event.data.size > maxBytes) { cancel('Recording exceeded the ' + Math.ceil(maxBytes / 1024) + ' KB limit and was discarded. Nothing was sent.'); return; }
        chunks.push(event.data); bytes += event.data.size;
      };
      instance.onerror = () => { if (attempt === generation) cancel('The microphone recording failed. Nothing was sent.'); };
      instance.onstop = () => {
        if (disposed || attempt !== generation) return;
        active = false; release();
        const blob = bytes ? new Blob(chunks, { type: instance.mimeType || chunks[0]?.type || 'audio/webm' }) : null;
        chunks = []; bytes = 0; recorder = null;
        emit(blob ? { phase: 'review', blob, notice: finishNotice || 'Recording is ready locally. Nothing has been sent.' } : { phase: 'idle', blob: null, notice: 'No audio was captured. Try again or type your question.' });
      };
      instance.start(250); emit({ phase: 'recording', blob: null, notice: 'Recording locally. Stop when ready. Maximum ' + Math.ceil(maxMs / 1000) + ' seconds or ' + Math.ceil(maxBytes / 1024) + ' KB.' });
      timer = setTimer(() => stop('The recording time limit was reached. Your recording is ready locally; nothing has been sent.'), maxMs);
    } catch { if (!disposed && attempt === generation) cancel('Microphone access is unavailable or was declined. Type your question or try recording again.'); }
  }
  return { start, stop, cancel, dispose() { if (!disposed) { cancel(''); disposed = true; } } };
}
