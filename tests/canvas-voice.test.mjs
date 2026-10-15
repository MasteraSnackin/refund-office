import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_VOICE_MAX_BYTES, readCanvasVoiceStatus, transcribeCanvasAudio } from '../src/canvas-voice.js';

const scenario = { id: 'saved-case', caseId: 'RF-2001', revision: 3 };
const identity = { caseId: scenario.id, revision: 3, provider: 'elevenlabs', model: 'scribe_v2' };
const blob = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 3, 4])], { type: 'audio/webm;codecs=opus' });

test('voice status is bound to the exact saved case and all activation flags', async () => {
  const calls = [];
  const read = value => readCanvasVoiceStatus({ scenario, apiClient: async (...args) => { calls.push(args); return { ...identity, ...value }; } });
  assert.equal((await read({ available: true, configured: true, enabled: true })).available, true);
  for (const missing of ['available', 'configured', 'enabled']) {
    const result = await read({ available: true, configured: true, enabled: true, [missing]: false });
    assert.equal(result.available, false); assert.match(result.reason, /disconnected/);
  }
  for (const changed of [{ caseId: 'other' }, { revision: 4 }, { provider: 'other' }, { model: 'other' }]) await assert.rejects(read(changed), /matched to this saved case/);
  assert.ok(calls.every(([path, options]) => path === '/cases/saved-case/voice-input' && options.method === 'GET'));
});

test('a recording is sent only to the case API with explicit consent and exact revision', async () => {
  let call;
  const result = await transcribeCanvasAudio({ scenario, blob: blob(), apiClient: async (...args) => { call = args; return { ...identity, text: '  Why is approval required?  ' }; } });
  assert.deepEqual(result, { text: 'Why is approval required?' });
  assert.equal(call[0], '/cases/saved-case/voice-input'); assert.equal(call[1].method, 'POST');
  assert.deepEqual(call[1].body, { expectedRevision: 3, consent: true, contentType: 'audio/webm;codecs=opus', audioBase64: 'GkXfowME' });
});

test('empty, oversized and unsupported recordings make no request', async () => {
  for (const value of [null, new Blob([],{type:'audio/webm'}), new Blob(['text'],{type:'text/plain'}), {type:'audio/webm',size:CANVAS_VOICE_MAX_BYTES+1,arrayBuffer:()=>assert.fail('read oversized input')}]) {
    await assert.rejects(transcribeCanvasAudio({scenario,blob:value,apiClient:()=>assert.fail('request sent')}), /No audio was sent/);
  }
});

test('changed identities and malformed transcripts never reach the composer', async () => {
  for (const value of [{...identity,revision:4,text:'Private'}, {...identity,caseId:'other',text:'Private'}, {...identity,provider:'other',text:'Private'}, {...identity,text:''}, {...identity,text:'x'.repeat(8001)}, {...identity,text:'bad\u0000text'}]) {
    await assert.rejects(transcribeCanvasAudio({scenario,blob:blob(),apiClient:async()=>value}), /Nothing was added/);
  }
});

test('cancelled or delayed voice work is fenced before reads and after responses', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(transcribeCanvasAudio({scenario,blob:blob(),signal:controller.signal,apiClient:()=>assert.fail('request sent')}),/earlier canvas/);
  await assert.rejects(readCanvasVoiceStatus({scenario,signal:controller.signal,apiClient:()=>assert.fail('request sent')}),/earlier canvas/);
  const active=new AbortController();
  await assert.rejects(transcribeCanvasAudio({scenario,blob:blob(),signal:active.signal,apiClient:async()=>{active.abort();return {...identity,text:'stale'};}}),/earlier canvas/);
});
