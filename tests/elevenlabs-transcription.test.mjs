import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsTranscription } from '../server/elevenlabs-transcription.mjs';
import { ProviderError } from '../server/providers.mjs';

const env = {
  REFUND_OFFICE_NETWORK: 'enabled',
  REFUND_OFFICE_ENABLED_INTEGRATIONS: 'elevenlabs-transcription',
  REFUND_OFFICE_VOICE_INPUT: 'elevenlabs',
  ELEVENLABS_API_KEY: 'fake-transcription-unit-test-key',
};
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67]);
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2]), Buffer.alloc(20), Buffer.from([1, 19]), Buffer.from('OpusHead'), Buffer.alloc(11)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42')]);
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(28)]);
const input = { bytes: webm, contentType: 'audio/webm;codecs=opus' };
const json = (value = { text: 'What does this evidence show?' }, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const withoutFetch = configuration => createElevenLabsTranscription({ env: configuration, fetchImpl: () => assert.fail('Unexpected provider access') });

test('voice input remains disconnected with ambient credentials unless all three activation gates are explicit', async () => {
  for (const override of [
    { REFUND_OFFICE_NETWORK: undefined }, { REFUND_OFFICE_NETWORK: 'offline' },
    { REFUND_OFFICE_ENABLED_INTEGRATIONS: undefined }, { REFUND_OFFICE_ENABLED_INTEGRATIONS: 'elevenlabs' },
    { REFUND_OFFICE_ENABLED_INTEGRATIONS: 'stripe-runtime,supabase-runtime' },
    { REFUND_OFFICE_VOICE_INPUT: undefined }, { REFUND_OFFICE_VOICE_INPUT: 'enabled' },
  ]) {
    const client = withoutFetch({ ...env, ...override });
    assert.equal(client.capabilities().configured, false);
    assert.equal(client.capabilities().networkMode, 'offline');
    assert.deepEqual(await client.transcribe(input), { available: false, provider: 'elevenlabs', model: 'scribe_v2', reason: 'ElevenLabs voice input is disconnected. No recording was uploaded.' });
  }
});

test('voice input requires a valid server key and retention configuration without exposing either key or transcript', async () => {
  for (const override of [
    { ELEVENLABS_API_KEY: undefined }, { ELEVENLABS_API_KEY: '' },
    { ELEVENLABS_API_KEY: 'private\r\nheader' }, { ELEVENLABS_API_KEY: 'x'.repeat(513) },
    { ELEVENLABS_STT_ENABLE_LOGGING: 'automatic' },
  ]) {
    const client = withoutFetch({ ...env, ...override });
    assert.equal(client.capabilities().configured, false);
    await assert.rejects(client.transcribe(input), { code: 'elevenlabs_transcription_not_configured' });
    assert.doesNotMatch(JSON.stringify(client.capabilities()), /fake-transcription|private|xi-api-key/);
  }
});

test('prepared transport sends only a bounded recording and deliberate synchronous transcript options', async () => {
  let call;
  const client = createElevenLabsTranscription({ env, fetchImpl: async (url, options) => { call = { url, ...options }; return json({ text: '  Explain this node.  ', words: [{ text: 'ignored', speaker_id: 'private' }], language_code: 'en' }); } });
  assert.equal(client.capabilities().configured, true);
  assert.equal(client.capabilities().verified, false);
  assert.equal(client.capabilities().retention, 'provider-account-default');
  assert.equal(client.capabilities().retentionVerified, false);
  assert.deepEqual(await client.transcribe({ ...input, filename: '../private-customer-name.webm' }), { available: true, provider: 'elevenlabs', model: 'scribe_v2', text: 'Explain this node.' });
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'error');
  assert.deepEqual(call.headers, { 'xi-api-key': env.ELEVENLABS_API_KEY, Accept: 'application/json' });
  assert.ok(call.signal instanceof AbortSignal);
  assert.ok(call.body instanceof FormData);
  assert.deepEqual([...call.body.keys()], ['file', 'model_id', 'file_format', 'timestamps_granularity', 'tag_audio_events', 'diarize', 'use_speaker_library', 'webhook']);
  const file = call.body.get('file');
  assert.equal(file.name, 'voice-input.webm');
  assert.equal(file.type, 'audio/webm');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), webm);
  assert.deepEqual(Object.fromEntries([...call.body].filter(([name]) => name !== 'file')), {
    model_id: 'scribe_v2', file_format: 'other', timestamps_granularity: 'none',
    tag_audio_events: 'false', diarize: 'false', use_speaker_library: 'false', webhook: 'false',
  });
});

test('retention requests are explicit and never silently changed after provider rejection', async () => {
  for (const [logging, retention] of [['false', 'zero-retention-requested'], ['true', 'provider-logging-requested']]) {
    const calls = [];
    const client = createElevenLabsTranscription({ env: { ...env, ELEVENLABS_STT_ENABLE_LOGGING: logging }, fetchImpl: async url => { calls.push(url); return json(); } });
    await client.transcribe(input);
    assert.deepEqual(calls, [`https://api.elevenlabs.io/v1/speech-to-text?enable_logging=${logging}`]);
    assert.equal(client.capabilities().retention, retention);
    assert.equal(client.capabilities().retentionVerified, false);
  }
  let calls = 0;
  const rejected = createElevenLabsTranscription({ env: { ...env, ELEVENLABS_STT_ENABLE_LOGGING: 'false' }, fetchImpl: async () => { calls++; return new Response('private retention failure', { status: 403 }); } });
  await assert.rejects(rejected.transcribe(input), { code: 'elevenlabs_transcription_http_403' });
  assert.equal(calls, 1);
});

test('MediaRecorder WebM, Ogg, MP4 and WAV headers are accepted with canonical upload types', async () => {
  for (const [bytes, contentType, uploadType, extension] of [
    [webm, 'audio/webm;codecs=opus', 'audio/webm', 'webm'],
    [ogg, 'audio/ogg; codecs=opus', 'audio/ogg', 'ogg'],
    [mp4, 'audio/mp4', 'audio/mp4', 'm4a'],
    [wav, 'audio/wav', 'audio/wav', 'wav'],
    [wav, 'audio/x-wav', 'audio/wav', 'wav'],
  ]) {
    const client = createElevenLabsTranscription({ env, fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('file').type, uploadType);
      assert.equal(options.body.get('file').name, `voice-input.${extension}`);
      return json();
    } });
    assert.equal((await client.transcribe({ bytes: new Uint8Array(bytes), contentType })).available, true);
  }
});

test('unsupported, empty, truncated, mismatched and oversized recordings fail before transport', async () => {
  const client = createElevenLabsTranscription({ env, maxAudioBytes: 64, fetchImpl: () => assert.fail('Unexpected provider access') });
  for (const invalid of [
    {}, { bytes: Buffer.alloc(0), contentType: 'audio/webm' }, { bytes: [1, 2, 3], contentType: 'audio/webm' },
    { bytes: webm, contentType: 'video/webm' }, { bytes: webm, contentType: 'audio/mpeg' },
    { bytes: webm, contentType: 'audio/ogg' }, { bytes: wav, contentType: 'audio/mp4' },
    { bytes: Buffer.from('private customer text'), contentType: 'audio/webm' },
    { bytes: webm.subarray(0, 8), contentType: 'audio/webm' },
    { bytes: Buffer.alloc(44), contentType: 'audio/wav' },
    { bytes: webm, contentType: 'audio/webm\r\nInjected: private' },
    { bytes: webm, contentType: 'audio/webm' + ' '.repeat(121) },
    { bytes: webm, contentType: null },
    { bytes: webm, contentType: 'audio/webm', signal: { aborted: false } },
  ]) await assert.rejects(client.transcribe(invalid), { code: 'audio_input_invalid' });
  await assert.rejects(client.transcribe({ ...input, bytes: Buffer.alloc(65) }), { code: 'audio_input_too_large' });
});

test('recording validation rejects other EBML documents, wrong Ogg pages and unsupported MP4 brands', async () => {
  const client = withoutFetch(env);
  const wrongWebm = Buffer.from(webm); wrongWebm.write('test', 8);
  const wrongOgg = Buffer.from(ogg); wrongOgg[5] = 0;
  const wrongMp4 = Buffer.from(mp4); wrongMp4.write('nope', 8); wrongMp4.write('nope', 16); wrongMp4.write('nope', 20);
  const oversizedBox = Buffer.from(mp4); oversizedBox.writeUInt32BE(100, 0);
  for (const [bytes, contentType] of [[wrongWebm, 'audio/webm'], [wrongOgg, 'audio/ogg'], [wrongMp4, 'audio/mp4'], [oversizedBox, 'audio/mp4']]) await assert.rejects(client.transcribe({ bytes, contentType }), { code: 'audio_input_invalid' });
});

test('response reads reject invalid types, unreadable JSON, empty text and out-of-bound transcripts', async () => {
  for (const response of [
    new Response('private provider html', { headers: { 'content-type': 'text/html' } }),
    new Response('private malformed response', { headers: { 'content-type': 'application/json' } }),
    new Response(Buffer.from([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
    new Response(null, { headers: { 'content-type': 'application/json' } }),
    json(null), json([]), json({}), json({ text: [] }), json({ text: '' }), json({ text: '   ' }),
    json({ text: 'x'.repeat(8001) }), json({ text: 'private\u0000transcript' }),
  ]) {
    const client = createElevenLabsTranscription({ env, fetchImpl: async () => response });
    await assert.rejects(client.transcribe(input), failure => failure.code === 'elevenlabs_transcription_invalid_response' && !failure.message.includes('private'));
  }
});

test('response size is bounded from both advertised length and streamed chunks and cancels overflow', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(40)); controller.enqueue(new Uint8Array(40)); },
    cancel() { cancelled = true; },
  });
  for (const response of [json({ text: 'small' }, { 'content-length': '200' }), new Response(stream, { headers: { 'content-type': 'application/json' } })]) {
    const client = createElevenLabsTranscription({ env, maxResponseBytes: 64, fetchImpl: async () => response });
    await assert.rejects(client.transcribe(input), { code: 'elevenlabs_transcription_response_too_large' });
  }
  assert.equal(cancelled, true);
});

test('server text limit is configurable and rejects excess before returning a transcript', async () => {
  const client = createElevenLabsTranscription({ env, maxTextLength: 8, fetchImpl: async () => json({ text: 'Too long for this limit.' }) });
  await assert.rejects(client.transcribe(input), { code: 'elevenlabs_transcription_invalid_response' });
});

test('HTTP errors never expose upstream bodies and do not retry or choose a replacement provider', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    const client = createElevenLabsTranscription({ env, fetchImpl: async () => { calls++; return new Response('PRIVATE_AUDIO_TRANSCRIPT_OR_KEY', { status }); } });
    await assert.rejects(client.transcribe(input), failure => failure instanceof ProviderError && failure.code === `elevenlabs_transcription_http_${status}` && failure.retryable === (status === 429 || status >= 500) && !JSON.stringify(failure).includes('PRIVATE') && !failure.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('transport and stream failures are redacted even if the transport throws a ProviderError', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('PRIVATE_AUDIO_TRANSCRIPT_OR_KEY'); },
    async () => { throw new ProviderError('private-code', 'PRIVATE_AUDIO_TRANSCRIPT_OR_KEY'); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_AUDIO_TRANSCRIPT_OR_KEY')); } }), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const client = createElevenLabsTranscription({ env, fetchImpl });
    await assert.rejects(client.transcribe(input), failure => failure.code === 'elevenlabs_transcription_unavailable' && !failure.message.includes('PRIVATE') && failure.cause === undefined);
  }
});

test('a pre-cancelled recording causes no provider request and does not echo its abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(withoutFetch(env).transcribe({ ...input, signal: controller.signal }), failure => failure.code === 'elevenlabs_transcription_cancelled' && !failure.message.includes('PRIVATE'));
});

test('caller cancellation interrupts a pending provider request without depending on transport cooperation', async () => {
  const controller = new AbortController();
  let providerSignal;
  const client = createElevenLabsTranscription({ env, fetchImpl: (_url, options) => { providerSignal = options.signal; controller.abort('PRIVATE_ABORT_REASON'); return new Promise(() => {}); } });
  await assert.rejects(client.transcribe({ ...input, signal: controller.signal }), { code: 'elevenlabs_transcription_cancelled' });
  assert.equal(providerSignal.aborted, true);
});

test('request timeout interrupts an uncooperative provider', async () => {
  let providerSignal;
  const client = createElevenLabsTranscription({ env, timeoutMs: 5, fetchImpl: (_url, options) => { providerSignal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(client.transcribe(input), { code: 'elevenlabs_transcription_timeout', retryable: true });
  assert.equal(providerSignal.aborted, true);
});

test('request timeout covers a hanging response body and cancels the stream', async () => {
  let cancelled = false;
  const client = createElevenLabsTranscription({ env, timeoutMs: 5, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.transcribe(input), { code: 'elevenlabs_transcription_timeout' });
  assert.equal(cancelled, true);
});

test('adapter bounds reject unsafe configuration before any transport can be used', () => {
  for (const options of [
    { maxAudioBytes: 0 }, { maxAudioBytes: 20 * 1024 * 1024 + 1 },
    { maxResponseBytes: 31 }, { maxResponseBytes: 1024 * 1024 + 1 },
    { maxTextLength: 0 }, { maxTextLength: 8001 },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120001 },
  ]) assert.throws(() => createElevenLabsTranscription({ env: {}, ...options }), TypeError);
});
