export const CANVAS_VOICE_MAX_BYTES = 2 * 1024 * 1024;
const types = new Set(['audio/webm', 'video/webm', 'audio/ogg', 'application/ogg', 'audio/mp4', 'video/mp4', 'audio/wav', 'audio/x-wav', 'audio/wave']);
const stopped = () => new Error('This recording belongs to an earlier canvas. Nothing was applied.');
const requireCurrent = signal => { if (signal?.aborted) throw stopped(); };
function savedIdentity(value, scenario) {
  return value && value.caseId === scenario.id && value.revision === scenario.revision && value.provider === 'elevenlabs' && value.model === 'scribe_v2';
}

export async function readCanvasVoiceStatus({ scenario, apiClient, signal }) {
  requireCurrent(signal);
  const value = await apiClient('/cases/' + encodeURIComponent(scenario.id) + '/voice-input', { method: 'GET', signal });
  requireCurrent(signal);
  if (!savedIdentity(value, scenario)) throw new Error('Voice input could not be matched to this saved case. Refresh the canvas.');
  const available = value.available === true && value.configured === true && value.enabled === true;
  return {
    provider: 'elevenlabs', model: 'scribe_v2', available, configured: available,
    reason: available ? '' : 'ElevenLabs voice input is disconnected. You can still type a question.',
    destination: 'ElevenLabs', maxAudioBytes: Math.min(CANVAS_VOICE_MAX_BYTES, Number.isSafeInteger(value.maxAudioBytes) && value.maxAudioBytes > 0 ? value.maxAudioBytes : CANVAS_VOICE_MAX_BYTES),
    retention: ['provider-account-default', 'provider-logging-requested', 'zero-retention-requested'].includes(value.retention) ? value.retention : 'provider-account-default',
    retentionVerified: false,
  };
}

export async function transcribeCanvasAudio({ scenario, apiClient, blob, signal }) {
  requireCurrent(signal);
  const contentType = typeof blob?.type === 'string' ? blob.type.toLowerCase().split(';')[0].trim() : '';
  if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > CANVAS_VOICE_MAX_BYTES || !types.has(contentType)) {
    throw new Error('Use a supported microphone recording smaller than 2 MiB. No audio was sent.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  requireCurrent(signal);
  if (bytes.byteLength !== blob.size) throw new Error('The recording could not be read completely. No audio was sent.');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  const value = await apiClient('/cases/' + encodeURIComponent(scenario.id) + '/voice-input', {
    method: 'POST', signal,
    body: { expectedRevision: scenario.revision, consent: true, contentType: blob.type, audioBase64: btoa(binary) },
  });
  requireCurrent(signal);
  if (!savedIdentity(value, scenario) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text)) {
    throw new Error('The transcript could not be verified for this saved case. Nothing was added to the conversation.');
  }
  return { text: value.text.trim() };
}
