import { ProviderError } from './providers.mjs';

export function createElevenLabs({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20000, maxAudioBytes = 8 * 1024 * 1024 } = {}) {
  const networkEnabled = env.REFUND_OFFICE_NETWORK === 'enabled';
  const key = networkEnabled ? (env.ELEVENLABS_API_KEY || '').trim() : '';
  const voiceId = networkEnabled ? (env.ELEVENLABS_VOICE_ID || '').trim() : '';
  const model = (env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();
  const configured = networkEnabled && Boolean(key) && /^[A-Za-z0-9_-]{1,100}$/.test(voiceId) && /^[A-Za-z0-9_-]{1,100}$/.test(model);
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 32 || maxAudioBytes > 20 * 1024 * 1024) throw new TypeError('Set an audio response bound between 32 bytes and 20 MiB.');
  const capabilities = () => ({ provider: 'elevenlabs', networkMode: networkEnabled ? 'external-enabled' : 'offline', configured, verified: false, audioGenerated: false });
  async function synthesise({ text } = {}) {
    if (!networkEnabled) return { available: false, provider: 'elevenlabs', reason: 'ElevenLabs is disconnected. No audio was generated.' };
    if (!configured) throw new ProviderError('elevenlabs_not_configured', 'ElevenLabs requires an API key and an explicitly selected voice identifier. No fallback voice was selected.');
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 8000) throw new ProviderError('invalid_briefing_text', 'Provide saved briefing text between 1 and 8,000 characters.');
    let response;
    try {
      response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model }),
      });
    } catch { throw new ProviderError('elevenlabs_unavailable', 'ElevenLabs did not return audio. No replacement speech provider was used.', { retryable: true }); }
    if (!response.ok) throw new ProviderError(`elevenlabs_http_${response.status}`, `ElevenLabs rejected the audio request (HTTP ${response.status}). No fallback speech was generated.`, { retryable: response.status === 429 || response.status >= 500 });
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg') {
      await response.body?.cancel();
      throw new ProviderError('elevenlabs_invalid_audio', 'ElevenLabs returned an unexpected content type. No audio was accepted.');
    }
    const advertisedLength = Number(response.headers.get('content-length'));
    if (advertisedLength > maxAudioBytes) {
      await response.body?.cancel();
      throw new ProviderError('elevenlabs_audio_too_large', 'The audio response exceeds the local size limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('elevenlabs_invalid_audio', 'ElevenLabs returned an empty audio response.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxAudioBytes) {
          await reader.cancel();
          throw new ProviderError('elevenlabs_audio_too_large', 'The audio response exceeds the local size limit.');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('elevenlabs_invalid_audio', 'The audio response ended before it could be read. No audio was accepted.', { retryable: true });
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const id3 = bytes.length >= 10 && bytes.subarray(0, 3).equals(Buffer.from('ID3')) && [2, 3, 4].includes(bytes[3]);
    const mpeg = bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0 && (bytes[2] & 0xf0) !== 0xf0;
    if (!id3 && !mpeg) throw new ProviderError('elevenlabs_invalid_audio', 'The response does not have a supported MP3 header. No audio was accepted.');
    return { available: true, provider: 'elevenlabs', contentType: 'audio/mpeg', bytes, byteLength: bytes.length };
  }
  return { capabilities, synthesise };
}
