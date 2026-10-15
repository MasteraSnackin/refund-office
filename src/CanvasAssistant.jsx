import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Mic, Send, Square, X } from 'lucide-react';
import { assistantMap, CANVAS_CHAT_LIMITS, canvasRecordAnswer, createCanvasVoiceRecorder, elevenLabsVoiceAvailability } from './canvas-assistant.js';
import './canvas-assistant.css';

const emptyVoice = () => ({ phase: 'idle', blob: null, notice: '' });
const fresh = (identityKey, map) => ({ identityKey, map, messages: [], draft: '', voice: emptyVoice(), open: true });
const prompts = ['What is the recommended amount?', 'Which evidence was cited?', 'What is the next step?', 'Explain the selected record'];

// map is the same verified board export (or provenance graph) shown by CaseCanvas.
// identityKey must bind case, saved revision, principal/workspace and current run.
export function CanvasAssistant({ map, identityKey, selectedNodeId, onSelectNode, transcribeAudio, voiceStatus }) {
  const current = useRef({ identityKey, map, transcribeAudio }); current.current = { identityKey, map, transcribeAudio };
  const mounted = useRef(true), generation = useRef(0), recording = useRef(null), transcription = useRef(null), recordedBlob = useRef(null), draftInput = useRef(null), historyView = useRef(null), panelOpen = useRef(true);
  const [state, setState] = useState(() => fresh(identityKey, map));
  const graph = assistantMap(map), valid = typeof identityKey === 'string' && !!identityKey && !!graph;
  const visible = state.identityKey === identityKey && state.map === map ? state : fresh(identityKey, map);
  const voice = elevenLabsVoiceAvailability(voiceStatus, transcribeAudio);
  const maxAudioBytes = Number.isSafeInteger(voiceStatus?.maxAudioBytes) && voiceStatus.maxAudioBytes > 0 ? Math.min(voiceStatus.maxAudioBytes, CANVAS_CHAT_LIMITS.recordingBytes) : CANVAS_CHAT_LIMITS.recordingBytes;
  const sameContext = () => mounted.current && valid && current.current.identityKey === identityKey && current.current.map === map;
  const update = change => { if (sameContext()) setState(value => value.identityKey === identityKey && value.map === map ? { ...value, ...change(value) } : value); };

  function clearVoice() { transcription.current?.abort(); transcription.current = null; recordedBlob.current = null; recording.current?.dispose(); recording.current = null; }
  useEffect(() => {
    mounted.current = true; panelOpen.current = true; generation.current++; clearVoice(); setState(fresh(identityKey, map));
    return () => { mounted.current = false; generation.current++; clearVoice(); };
  }, [identityKey, map]);
  useEffect(() => {
    if (historyView.current) historyView.current.scrollTop = historyView.current.scrollHeight;
  }, [identityKey, map, visible.messages]);

  function sendQuestion(value) {
    if (!sameContext() || !panelOpen.current) return;
    const question = value.trim().slice(0, CANVAS_CHAT_LIMITS.question);
    if (!question || ['requesting', 'recording', 'stopping', 'transcribing'].includes(visible.voice.phase)) return;
    const answer = canvasRecordAnswer(map, question, selectedNodeId);
    update(previous => ({ draft: '', messages: [...previous.messages, { question, answer }].slice(-CANVAS_CHAT_LIMITS.messages) }));
  }
  function discardVoice() {
    if (!sameContext()) return;
    generation.current++; clearVoice(); update(() => ({ voice: { ...emptyVoice(), notice: 'Recording discarded. Nothing was sent to chat or saved as evidence.' } }));
  }
  async function startRecording() {
    if (!sameContext() || !voice.available || !panelOpen.current || ['requesting', 'recording', 'stopping', 'transcribing'].includes(visible.voice.phase)) return;
    clearVoice();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { update(() => ({ voice: { ...emptyVoice(), notice: 'This browser does not provide microphone recording. Type your question instead.' } })); return; }
    const attempt = ++generation.current;
    recording.current = createCanvasVoiceRecorder({ getUserMedia: options => navigator.mediaDevices.getUserMedia(options), MediaRecorder, maxBytes: maxAudioBytes, onChange: next => { if (attempt === generation.current && sameContext()) { recordedBlob.current = next.phase === 'review' ? next.blob : null; update(() => ({ voice: next })); } } });
    await recording.current.start();
  }
  async function transcribe() {
    if (!sameContext() || !voice.available || !panelOpen.current || transcription.current || visible.voice.phase !== 'review' || !visible.voice.blob || recordedBlob.current !== visible.voice.blob || visible.voice.blob.size > maxAudioBytes) return;
    const blob = visible.voice.blob, adapter = transcribeAudio, attempt = ++generation.current, controller = new AbortController(); transcription.current?.abort(); transcription.current = controller; recordedBlob.current = null;
    update(() => ({ voice: { phase: 'transcribing', blob: null, notice: 'Sending this recording to ElevenLabs for transcription…' } }));
    try {
      const result = await adapter({ blob, signal: controller.signal, provider: 'elevenlabs' });
      if (controller.signal.aborted || attempt !== generation.current || !sameContext()) return;
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 20000) throw new Error('Invalid transcript');
      const transcript = result.text.trim().slice(0, CANVAS_CHAT_LIMITS.question);
      recording.current?.dispose(); recording.current = null;
      update(previous => ({ draft: [previous.draft, transcript].filter(Boolean).join('\n').slice(0, CANVAS_CHAT_LIMITS.question), voice: { ...emptyVoice(), notice: 'Transcript added to the editable question. Review it, then choose Send question. It has not been sent to chat or saved as evidence.' } }));
      draftInput.current?.focus?.();
    } catch {
      if (!controller.signal.aborted && attempt === generation.current && sameContext()) { recording.current?.dispose(); recording.current = null; update(() => ({ voice: { ...emptyVoice(), notice: 'ElevenLabs transcription did not complete. No question was sent. Type your question or record again.' } })); }
    } finally { if (transcription.current === controller) transcription.current = null; }
  }
  function toggleOpen() {
    if (!sameContext()) return;
    if (panelOpen.current) { panelOpen.current = false; generation.current++; clearVoice(); update(() => ({ open: false, messages: [], draft: '', voice: emptyVoice() })); }
    else { panelOpen.current = true; update(() => ({ open: true })); }
  }
  const voiceBusy = ['requesting', 'recording', 'stopping', 'transcribing'].includes(visible.voice.phase);

  return <section className={'canvas-assistant' + (visible.open ? ' is-open' : '')} aria-label="Saved case chat">
    <header className="canvas-assistant-header"><div><MessageSquare size={16} aria-hidden="true" /><h3>Ask this case</h3><span>Local records</span></div><button type="button" aria-expanded={visible.open} onClick={toggleOpen} disabled={!valid} aria-label={visible.open ? 'Close case chat panel' : 'Open case chat panel'}>{visible.open ? <X size={16} aria-hidden="true" /> : 'Open'}</button></header>
    {visible.open && <div className="canvas-assistant-content">
      <p className="canvas-assistant-boundary">Local record-based answers. No AI model is called. This chat cannot approve, pay, publish or change evidence.</p>
      {!valid ? <p role="alert">A verified saved map and case identity are required. Refresh the case canvas.</p> : <>
        <div className="canvas-assistant-prompts" aria-label="Suggested case questions">{prompts.map(prompt => <button type="button" key={prompt} disabled={voiceBusy} onClick={() => sendQuestion(prompt)}>{prompt}</button>)}</div>
        <div ref={historyView} className="canvas-assistant-history" role="log" aria-label="Case questions and record-based answers" aria-live="polite" aria-relevant="additions text" tabIndex={0}>
          {!visible.messages.length && <p className="canvas-assistant-empty">Ask about the amount, evidence, saved checks or next step. Citation buttons select the actual canvas record.</p>}
          {visible.messages.map(({ question, answer }, index) => <article className="canvas-assistant-exchange" key={index}><p className="canvas-assistant-question"><span>Your question</span>{question}</p><div className="canvas-assistant-answer"><strong>Local record-based answer</strong><p>{answer.text}</p>{answer.records.map(record => <section className="canvas-assistant-record" key={record.id}><button type="button" className="canvas-assistant-citation" aria-label={'Select cited record: ' + record.title} onClick={() => { if (sameContext() && graph.nodes.some(node => node.id === record.id)) onSelectNode?.(record.id); }}>{record.title}</button>{record.relation && <p className="canvas-assistant-relation">{record.relation}</p>}<blockquote>{record.text || 'No text is saved in this map record.'}</blockquote>{record.excerpt && <small>Excerpt. Select the cited record for more saved text.</small>}</section>)}{answer.note && <p className="canvas-assistant-note">{answer.note}</p>}</div></article>)}
        </div>
        <div className="canvas-assistant-voice">
          <p>{voice.available ? "Voice destination: ElevenLabs transcription, under the account’s retention settings. Recordings stay in this panel until you choose Transcribe with ElevenLabs. Only recorded audio is sent; the case map is not included." : 'Voice unavailable: ' + voice.reason}</p>
          <div className="canvas-assistant-voice-actions">
            {(!voiceBusy && visible.voice.phase !== 'review') && <button type="button" disabled={!voice.available} onClick={startRecording}><Mic size={14} aria-hidden="true" />Record question</button>}
            {visible.voice.phase === 'recording' && <button type="button" onClick={() => { if (sameContext()) recording.current?.stop(); }}><Square size={13} aria-hidden="true" />Stop recording</button>}
            {visible.voice.phase === 'review' && <><span>{Math.ceil(visible.voice.blob.size / 1024)} KB held locally</span><button type="button" disabled={!voice.available} onClick={transcribe}>Transcribe with ElevenLabs</button></>}
            {(voiceBusy || visible.voice.phase === 'review') && <button type="button" onClick={discardVoice}>{visible.voice.phase === 'transcribing' ? 'Cancel transcription' : 'Discard recording'}</button>}
          </div>
          <p role="status" aria-live="polite" className="canvas-assistant-status">{visible.voice.notice}</p>
        </div>
        <div className="canvas-assistant-compose"><label><span>Question about this saved case</span><textarea ref={draftInput} value={visible.draft} maxLength={CANVAS_CHAT_LIMITS.question} rows={2} placeholder="Type a question or review a voice transcript" onChange={event => { const draft = event.target.value.slice(0, CANVAS_CHAT_LIMITS.question); update(() => ({ draft })); }} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); sendQuestion(visible.draft); } }} /></label><div><small>Review before sending · Ctrl/⌘ + Enter</small><button type="button" disabled={!visible.draft.trim() || voiceBusy} onClick={() => sendQuestion(visible.draft)}><Send size={14} aria-hidden="true" />Send question</button></div></div>
        <p className="canvas-assistant-memory">Conversation and recordings stay in memory and clear when the case, revision, workspace or run changes.</p>
      </>}
    </div>}
  </section>;
}
