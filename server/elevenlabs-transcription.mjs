import { ProviderError } from './providers.mjs';

const PROVIDER = 'elevenlabs';
const MODEL = 'scribe_v2';
// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
// enable_logging is a query option. false requests Enterprise-only zero retention;
// neither requesting it nor local tests verify the account's retention behaviour.
const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const trustedErrors = new WeakSet();
const error = (code, message, options) => {
  const value = new ProviderError(code, message, options);
  trustedErrors.add(value);
  return value;
};
const formats = new Map([
  ['audio/webm', { extension: 'webm', signature: bytes => {
    // MediaRecorder WebM begins with an EBML header identifying its DocType.
    if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
    const header = bytes.subarray(4, Math.min(bytes.length, 4096));
    const docType = header.indexOf(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
    return docType !== -1;
  } }],
  ['audio/ogg', { extension: 'ogg', signature: bytes => {
    if (bytes.length < 36 || bytes.subarray(0, 4).toString('ascii') !== 'OggS' || bytes[4] !== 0 || !(bytes[5] & 2)) return false;
    const segments = bytes[26];
    const start = 27 + segments;
    if (segments < 1 || bytes.length < start + 8 || bytes[27] < 8) return false;
    return bytes.subarray(start, start + 8).toString('ascii') === 'OpusHead' || bytes.subarray(start, start + 7).equals(Buffer.from([1, 118, 111, 114, 98, 105, 115]));
  } }],
  ['audio/mp4', { extension: 'm4a', signature: bytes => {
    if (bytes.length < 16 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
    const boxLength = bytes.readUInt32BE(0);
    if (boxLength < 16 || boxLength > bytes.length || boxLength > 4096 || boxLength % 4 !== 0) return false;
    const brands = [bytes.subarray(8, 12).toString('ascii')];
    for (let offset = 16; offset < boxLength; offset += 4) brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
    return brands.some(brand => /^(?:M4[AB] |isom|iso[2-9]|mp4[12]|avc1|dash|cmf[cs]|qt  )$/.test(brand));
  } }],
  ['audio/wav', { extension: 'wav', signature: bytes => bytes.length >= 44 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE' }],
]);
const aliases = new Map([['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav']]);

function boundedOption(value, minimum, maximum, description) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(description);
}

/**
 * Prepared server-only speech input transport. Caller controls recording duration,
 * obtains permission for upload, and keeps recognised text as an editable draft.
 * Container checks recognise supported headers; they do not decode the recording.
 */
export function createElevenLabsTranscription({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  maxAudioBytes = 8 * 1024 * 1024,
  maxResponseBytes = 256 * 1024,
  maxTextLength = 8000,
} = {}) {
  boundedOption(timeoutMs, 1, 120000, 'Set a transcription timeout between 1 and 120,000 milliseconds.');
  boundedOption(maxAudioBytes, 32, 20 * 1024 * 1024, 'Set an audio upload bound between 32 bytes and 20 MiB.');
  boundedOption(maxResponseBytes, 32, 1024 * 1024, 'Set a transcription response bound between 32 bytes and 1 MiB.');
  boundedOption(maxTextLength, 1, 8000, 'Set a transcription text bound between 1 and 8,000 characters.');
  const networkEnabled = env.REFUND_OFFICE_NETWORK === 'enabled';
  const serviceEnabled = String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(value => value.trim()).includes('elevenlabs-transcription');
  const featureEnabled = env.REFUND_OFFICE_VOICE_INPUT === 'elevenlabs';
  const enabled = networkEnabled && serviceEnabled && featureEnabled;
  // Ambient credentials cannot activate a transport or appear in capabilities.
  const key = enabled && typeof env.ELEVENLABS_API_KEY === 'string' ? env.ELEVENLABS_API_KEY.trim() : '';
  const logging = env.ELEVENLABS_STT_ENABLE_LOGGING;
  const validLogging = logging === undefined || logging === '' || logging === 'true' || logging === 'false';
  const configured = enabled && /^[\x21-\x7e]{1,512}$/.test(key) && validLogging;
  const retention = logging === 'false' ? 'zero-retention-requested' : logging === 'true' ? 'provider-logging-requested' : 'provider-account-default';
  const capabilities = () => ({
    provider: PROVIDER, model: MODEL, enabled, configured,
    networkMode: enabled ? 'external-enabled' : 'offline',
    verified: false, retention, retentionVerified: false,
    maxAudioBytes, maxTextLength,
    acceptedContentTypes: [...formats.keys()],
  });

  async function transcribe({ bytes, contentType, signal } = {}) {
    if (!enabled) return { available: false, provider: PROVIDER, model: MODEL, reason: 'ElevenLabs voice input is disconnected. No recording was uploaded.' };
    if (!configured) throw error('elevenlabs_transcription_not_configured', 'Voice input requires a server API key and valid retention configuration.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) throw error('audio_input_invalid', 'Provide a non-empty recording in a supported audio format.');
    if (bytes.byteLength > maxAudioBytes) throw error('audio_input_too_large', 'The recording exceeds the audio upload limit.');
    if (typeof contentType !== 'string' || contentType.length > 120 || /[\r\n]/.test(contentType)) throw error('audio_input_invalid', 'The recording has an unsupported audio type.');
    const requestedType = contentType.split(';')[0].trim().toLowerCase();
    const type = aliases.get(requestedType) || requestedType;
    const format = formats.get(type);
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!format || !format.signature(input)) throw error('audio_input_invalid', 'The recording does not have a supported audio header matching its type.');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw error('audio_input_invalid', 'Provide a valid recording cancellation signal.');
    if (signal?.aborted) throw error('elevenlabs_transcription_cancelled', 'Voice transcription was cancelled.');

    const body = new FormData();
    // Never pass a source filename, customer reference or chat context upstream.
    body.append('file', new Blob([input], { type }), `voice-input.${format.extension}`);
    body.append('model_id', MODEL);
    body.append('file_format', 'other');
    body.append('timestamps_granularity', 'none');
    body.append('tag_audio_events', 'false');
    body.append('diarize', 'false');
    body.append('use_speaker_library', 'false');
    body.append('webhook', 'false');
    const url = logging === 'true' || logging === 'false' ? `${ENDPOINT}?enable_logging=${logging}` : ENDPOINT;
    const controller = new AbortController();
    let reader;
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = timedOut => {
      controller.abort();
      // A custom/injected transport must not leave the request deadline waiting.
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
      rejectAbort(error(timedOut ? 'elevenlabs_transcription_timeout' : 'elevenlabs_transcription_cancelled', timedOut ? 'ElevenLabs voice transcription timed out. No text was accepted.' : 'Voice transcription was cancelled.', { retryable: timedOut }));
    };
    const onAbort = () => abort(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort(true), timeoutMs);
    const request = async () => {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'xi-api-key': key, Accept: 'application/json' }, body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 502;
        throw error(`elevenlabs_transcription_http_${status}`, 'ElevenLabs rejected the transcription request. Check the server key, quota and requested retention setting.', { retryable: status === 429 || status >= 500 });
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        await response.body?.cancel();
        throw error('elevenlabs_transcription_invalid_response', 'ElevenLabs returned an unexpected response type. No text was accepted.');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) {
        await response.body?.cancel();
        throw error('elevenlabs_transcription_response_too_large', 'The transcription response exceeds its local size limit.');
      }
      reader = response.body?.getReader();
      if (!reader) throw error('elevenlabs_transcription_invalid_response', 'ElevenLabs returned no transcription response.');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) {
            await reader.cancel();
            throw error('elevenlabs_transcription_response_too_large', 'The transcription response exceeds its local size limit.');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      let result;
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw error('elevenlabs_transcription_invalid_response', 'ElevenLabs returned an unreadable transcription response.'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > maxTextLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.text)) {
        throw error('elevenlabs_transcription_invalid_response', 'ElevenLabs did not return a non-empty transcript within the text limit.');
      }
      return { available: true, provider: PROVIDER, model: MODEL, text: result.text.trim() };
    };
    try { return await Promise.race([request(), cancelled]); }
    catch (failure) {
      if (trustedErrors.has(failure)) throw failure;
      throw error('elevenlabs_transcription_unavailable', 'ElevenLabs did not return a usable transcription. No replacement provider was used.', { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return { capabilities, transcribe };
}
