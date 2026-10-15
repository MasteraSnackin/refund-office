import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabs } from '../server/elevenlabs.mjs';

const env = { REFUND_OFFICE_NETWORK: 'enabled', ELEVENLABS_API_KEY: 'fake-unit-test-only', ELEVENLABS_VOICE_ID: 'FakeVoiceForTests', ELEVENLABS_MODEL: 'eleven_multilingual_v2' };
const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...new Array(28).fill(0)]);
const mp3 = (bytes = audio, headers = {}) => new Response(bytes, { headers: { 'content-type': 'audio/mpeg', ...headers } });

test('ElevenLabs stays offline with ambient secrets and never silently uses another voice', async () => {
  let calls = 0;
  const client = createElevenLabs({ env: { ...env, REFUND_OFFICE_NETWORK: 'offline' }, fetchImpl: () => { calls++; assert.fail('external access'); } });
  assert.equal(client.capabilities().configured, false);
  assert.deepEqual(await client.synthesise({ text: 'Saved case briefing.' }), { available: false, provider: 'elevenlabs', reason: 'ElevenLabs is disconnected. No audio was generated.' });
  assert.equal(calls, 0);
  for (const missing of [{ ELEVENLABS_API_KEY: '' }, { ELEVENLABS_VOICE_ID: '' }, { ELEVENLABS_VOICE_ID: '../unselected' }]) {
    const invalid = createElevenLabs({ env: { ...env, ...missing }, fetchImpl: () => assert.fail('external access') });
    await assert.rejects(invalid.synthesise({ text: 'Briefing.' }), { code: 'elevenlabs_not_configured' });
  }
});

test('prepared ElevenLabs transport sends the exact saved text and selected voice', async () => {
  let call;
  const client = createElevenLabs({ env, fetchImpl: async (url, options) => { call = { url, ...options }; return mp3(); } });
  const result = await client.synthesise({ text: 'Human approval is still required. No refund has been submitted.' });
  assert.equal(client.capabilities().verified, false);
  assert.equal(result.available, true);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.deepEqual(result.bytes, audio);
  assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/FakeVoiceForTests?output_format=mp3_44100_128');
  assert.equal(call.headers['xi-api-key'], env.ELEVENLABS_API_KEY);
  assert.equal(call.redirect, 'error');
  assert.deepEqual(JSON.parse(call.body), { text: 'Human approval is still required. No refund has been submitted.', model_id: 'eleven_multilingual_v2' });
});

test('ElevenLabs rejects invalid text before calling its transport', async () => {
  const client = createElevenLabs({ env, fetchImpl: () => assert.fail('network access') });
  for (const text of ['', ' ', null, 123, 'x'.repeat(8001)]) await assert.rejects(client.synthesise({ text }), { code: 'invalid_briefing_text' });
});

test('ElevenLabs rejects unexpected types, empty data and non-MP3 payloads', async () => {
  for (const response of [new Response('private error body', { headers: { 'content-type': 'application/json' } }), mp3(Buffer.alloc(0)), mp3(Buffer.from('not audio'))]) {
    const client = createElevenLabs({ env, fetchImpl: async () => response });
    await assert.rejects(client.synthesise({ text: 'Briefing.' }), { code: 'elevenlabs_invalid_audio' });
  }
});

test('ElevenLabs bounds both advertised and streaming byte counts', async () => {
  for (const response of [mp3(audio, { 'content-length': '1000' }), mp3(Buffer.concat([audio, audio]))]) {
    const client = createElevenLabs({ env, maxAudioBytes: 32, fetchImpl: async () => response });
    await assert.rejects(client.synthesise({ text: 'Briefing.' }), { code: 'elevenlabs_audio_too_large' });
  }
});

test('ElevenLabs failures are redacted and do not produce fallback audio', async () => {
  const client = createElevenLabs({ env, fetchImpl: async () => new Response('NEVER_ECHO_PRIVATE_INPUT', { status: 401 }) });
  await assert.rejects(client.synthesise({ text: 'Briefing.' }), error => error.code === 'elevenlabs_http_401' && !error.message.includes('NEVER_ECHO'));
  const offline = createElevenLabs({ env, fetchImpl: async () => { throw new Error('NEVER_ECHO_PRIVATE_INPUT'); } });
  await assert.rejects(offline.synthesise({ text: 'Briefing.' }), error => error.code === 'elevenlabs_unavailable' && !error.message.includes('NEVER_ECHO'));
});
