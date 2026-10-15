import { createHash } from 'node:crypto';

export const VOICE_INPUT_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const VOICE_INPUT_MAX_BODY_BYTES = 3 * 1024 * 1024;
export const VOICE_INPUT_MAX_TEXT_LENGTH = 8000;
const route = /^\/api\/cases\/([A-Za-z0-9][A-Za-z0-9_-]{0,159})\/voice-input$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const contentTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav'];
const aliases = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav' };
const fields = ['expectedRevision', 'consent', 'contentType', 'audioBase64'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CanvasVoiceError extends Error {
  constructor(status, code, message) { super(message); this.name = 'CanvasVoiceError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new CanvasVoiceError(status, code, message); };
export const voiceInputCaseId = path => route.exec(path)?.[1] || null;
export const runtimeJsonBodyLimit = (path, method) => method === 'POST' && voiceInputCaseId(path) ? VOICE_INPUT_MAX_BODY_BYTES : 16 * 1024;

function member(principal) {
  if (!principal || !UUID.test(principal.userId || '') || !UUID.test(principal.tenantId || '') || !['reviewer', 'investigator'].includes(principal.role)
    || principal.machine === true || principal.authentication === 'machine' || principal.profileId === 'background-worker') {
    fail(403, 'voice_input_access_denied', 'A signed-in reviewer or investigator is required for voice input.');
  }
}
function input(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || body.consent !== true) {
    fail(400, 'invalid_voice_input', 'Send only the saved revision, explicit recording consent, audio type and recording.');
  }
  if (typeof body.contentType !== 'string' || body.contentType.length > 120 || !/^audio\/[a-z0-9-]+(?:\s*;\s*codecs\s*=\s*(?:"[a-z0-9.,_-]+"|[a-z0-9.,_-]+))?$/i.test(body.contentType)) {
    fail(400, 'invalid_voice_input', 'The recording has an unsupported audio type.');
  }
  const requested = body.contentType.split(';')[0].trim().toLowerCase(), contentType = aliases[requested] || requested;
  if (!contentTypes.includes(contentType)) fail(400, 'invalid_voice_input', 'The recording has an unsupported audio type.');
  if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) fail(400, 'invalid_voice_input', 'Provide a non-empty base64 recording.');
  // Check the encoded bound before allocating a decoded copy. Strict canonical
  // base64 rejects whitespace, data URLs, surplus padding and ignored bytes.
  if (body.audioBase64.length > Math.ceil(VOICE_INPUT_MAX_AUDIO_BYTES / 3) * 4) fail(413, 'voice_input_too_large', 'The recording exceeds the 2 MiB upload limit.');
  if (body.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.audioBase64)) {
    fail(400, 'invalid_voice_input', 'Provide a canonical base64 recording.');
  }
  const padding = body.audioBase64.endsWith('==') ? 2 : body.audioBase64.endsWith('=') ? 1 : 0;
  const length = body.audioBase64.length / 4 * 3 - padding;
  if (length > VOICE_INPUT_MAX_AUDIO_BYTES) fail(413, 'voice_input_too_large', 'The recording exceeds the 2 MiB upload limit.');
  return { contentType, length };
}
function providerFailure(cause) {
  if (cause instanceof CanvasVoiceError) throw cause;
  if (cause?.code === 'audio_input_invalid') fail(400, 'invalid_voice_input', 'The recording does not match a supported audio format.');
  if (cause?.code === 'audio_input_too_large') fail(413, 'voice_input_too_large', 'The recording exceeds the 2 MiB upload limit.');
  if (cause?.code === 'elevenlabs_transcription_cancelled') fail(409, 'voice_input_cancelled', 'Voice transcription was cancelled. No text was saved.');
  if (cause?.code === 'elevenlabs_transcription_timeout') fail(504, 'voice_input_timeout', 'Voice transcription timed out. No text was saved. Start a new recording if needed.');
  fail(503, 'voice_input_unavailable', 'Voice transcription could not be confirmed. No text was saved. Start a new recording or type your question.');
}

// No writer, evidence recorder, chat persistence or payment interface is
// available here. Only the explicitly consented recording crosses upstream.
export function createCanvasVoice({ getPacket, transcription, inFlight = new Set(), timeoutMs = 18000, checkAccess = () => {} } = {}) {
  if (typeof getPacket !== 'function' || typeof transcription?.capabilities !== 'function' || typeof transcription?.transcribe !== 'function') throw new TypeError('Voice input requires a scoped saved-case reader and transcription adapter.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 20000) throw new TypeError('Use a voice-input timeout below 20 seconds.');
  function capabilities() {
    const value = transcription.capabilities();
    const retention = ['zero-retention-requested', 'provider-logging-requested', 'provider-account-default'].includes(value.retention) ? value.retention : 'provider-account-default';
    return { provider: 'elevenlabs', model: 'scribe_v2', enabled: value.enabled === true, configured: value.configured === true,
      available: value.enabled === true && value.configured === true, verified: false, retention, retentionVerified: false,
      maxAudioBytes: VOICE_INPUT_MAX_AUDIO_BYTES, maxTextLength: VOICE_INPUT_MAX_TEXT_LENGTH,
      acceptedContentTypes: [...contentTypes], requiresConsent: true, changesSavedCase: false };
  }
  async function saved(principal, caseId, revision) {
    member(principal);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(caseId || '')) fail(400, 'invalid_voice_input', 'Use a valid saved case identifier.');
    let packet;
    try { await checkAccess(principal); packet = await getPacket(principal, caseId); }
    catch (cause) {
      if (cause instanceof CanvasVoiceError) throw cause;
      if (cause?.status === 409) fail(409, 'voice_input_stale_case', 'The saved workspace or case changed. Refresh before recording again.');
      if ([401, 403, 404].includes(cause?.status)) fail(403, 'voice_input_access_denied', 'The saved case is no longer available to this session.');
      fail(503, 'voice_input_case_unavailable', 'The saved case could not be checked. No text was saved.');
    }
    if (packet?.tenantId !== principal.tenantId || packet.case?.id !== caseId || !Number.isSafeInteger(packet.case.revision) || packet.case.revision < 1) fail(403, 'voice_input_access_denied', 'The saved case is not available in this workspace.');
    if (revision !== undefined && packet.case.revision !== revision) fail(409, 'voice_input_stale_case', 'The saved case changed. Refresh before recording again.');
    return { caseId, revision: packet.case.revision, fingerprint: digest({ case: packet.case, order: packet.order }) };
  }
  return {
    async status(principal, caseId) { const current = await saved(principal, caseId); return { caseId, revision: current.revision, ...capabilities() }; },
    async transcribe(principal, caseId, body, { signal } = {}) {
      member(principal);
      const checked = input(body), before = await saved(principal, caseId, body.expectedRevision);
      if (!capabilities().available) fail(503, 'voice_input_disconnected', 'ElevenLabs voice input is disconnected. No recording was uploaded. Type your question instead.');
      if (signal?.aborted) fail(409, 'voice_input_cancelled', 'Voice transcription was cancelled. No text was saved.');
      const key = `${principal.tenantId}:${principal.userId}`;
      if (inFlight.has(key)) fail(409, 'voice_input_in_progress', 'A voice transcription is already running for this user.');
      const bytes = Buffer.from(body.audioBase64, 'base64');
      if (bytes.length !== checked.length || bytes.toString('base64') !== body.audioBase64) fail(400, 'invalid_voice_input', 'Provide a canonical base64 recording.');
      inFlight.add(key);
      const controller = new AbortController(); let timer, onAbort;
      try {
        const cancelled = new Promise((_, reject) => {
          onAbort = () => { controller.abort(); reject(new CanvasVoiceError(409, 'voice_input_cancelled', 'Voice transcription was cancelled. No text was saved.')); };
          signal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => { controller.abort(); reject(new CanvasVoiceError(504, 'voice_input_timeout', 'Voice transcription timed out. No text was saved. Start a new recording if needed.')); }, timeoutMs);
        });
        const result = await Promise.race([transcription.transcribe({ bytes, contentType: checked.contentType, filename: 'voice-input', signal: controller.signal }), cancelled]);
        if (signal?.aborted) fail(409, 'voice_input_cancelled', 'Voice transcription was cancelled. No text was saved.');
        const after = await saved(principal, caseId, body.expectedRevision);
        if (before.fingerprint !== after.fingerprint) fail(409, 'voice_input_stale_case', 'The saved evidence changed while transcription ran. Refresh before recording again.');
        if (result?.provider !== 'elevenlabs' || result.model !== 'scribe_v2' || typeof result.text !== 'string' || !result.text.trim() || result.text.length > VOICE_INPUT_MAX_TEXT_LENGTH) {
          fail(502, 'voice_input_unverified', 'The transcription did not return a usable text draft. No text was saved.');
        }
        return { caseId, revision: body.expectedRevision, provider: 'elevenlabs', model: 'scribe_v2', text: result.text };
      } catch (cause) { return providerFailure(cause); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); inFlight.delete(key); bytes.fill(0); }
    },
  };
}
