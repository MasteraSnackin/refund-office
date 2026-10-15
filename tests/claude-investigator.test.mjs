import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeInvestigator } from '../server/claude-investigator.mjs';
import { createInvestigationProviders, prepareInvestigationProposal, investigationIdentity } from '../server/investigation-proposal.mjs';
import { LANGUAGE_ORDER } from './fixtures/claim-language.mjs';

const env = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: 'anthropic', REFUND_OFFICE_ENABLED_INTEGRATIONS: 'anthropic', REFUND_OFFICE_ANTHROPIC_MODE: 'tools', ANTHROPIC_API_KEY: 'test-only-secret-value', ANTHROPIC_MODEL: 'claude-fixture-model' };
const privateText = 'PRIVATE customer statement and source https://private.invalid/customer';
const input = () => ({ complaint: 'The sketchbook is missing.', order: structuredClone(LANGUAGE_ORDER), evidence: ['order','packing','delivery','remedies'].map(kind => ({ id: `${kind}:LANG-O1`, body: privateText, source: 'Synthetic catalogue' })) });
const good = () => ({ amountMinor: 1000, lineId: 'LANG-SKETCH', issue: 'item_missing', reason: 'Packing omits the supplied sketchbook.', evidenceIds: ['order:LANG-O1','packing:LANG-O1'] });
const call = (name, args, id = 'tool_'+name) => ({ type: 'tool_use', id, name, input: args });
const readCalls = () => [call('read_order',{}),call('read_evidence',{ids:input().evidence.map(item=>item.id)})];
function response(content, index = 1, extra = {}) {
  return Response.json({ id: 'msg_fixture_'+index, model: 'claude-returned-fixture', stop_reason: 'tool_use', usage: {input_tokens:100,output_tokens:20}, content, ...extra }, { headers: {'request-id':'req_fixture_'+index} });
}
function fixture({ outputs = [readCalls(),[call('submit_recommendation',good())]], factory = false, extra = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { assert.equal(url,'https://api.anthropic.com/v1/messages'); calls.push(JSON.parse(init.body)); const output = outputs[calls.length-1]; return output instanceof Response ? output : response(output,calls.length); };
  const provider = factory ? createInvestigationProviders({env,fetchImpl,responseMode:'controlled-test'}) : createClaudeInvestigator({env,fetchImpl,responseMode:'controlled-test',...extra});
  return {provider,calls};
}

test('factory remains offline and does not read credentials or tool mode when network is disabled', async () => {
  const source = new Proxy({REFUND_OFFICE_NETWORK:'offline'}, {get(value,key){ assert.equal(key,'REFUND_OFFICE_NETWORK'); return value[key]; }});
  const provider = createInvestigationProviders({env:source,fetchImpl:()=>assert.fail('No request is allowed')});
  assert.equal(provider.capabilities().analyser,'local');
  const result = await provider.proposeCase(input()); assert.equal(result.source,'local');
});

test('tool selection requires explicit network, selected analyser, allowlist, key and model', () => {
  for (const patch of [{REFUND_OFFICE_NETWORK:'offline'},{REFUND_OFFICE_ANALYSER:'local'},{REFUND_OFFICE_ENABLED_INTEGRATIONS:''},{REFUND_OFFICE_ANTHROPIC_MODE:''},{ANTHROPIC_API_KEY:''},{ANTHROPIC_MODEL:''}]) assert.throws(()=>createClaudeInvestigator({env:{...env,...patch}}));
  const disabled = new Proxy({...env,REFUND_OFFICE_ENABLED_INTEGRATIONS:''},{get(value,key){if(/API_KEY/.test(String(key)))assert.fail('A disabled key was read');return value[key];}});
  assert.throws(()=>createInvestigationProviders({env:disabled}),{code:'analysis_disconnected'});
  assert.throws(()=>createClaudeInvestigator({env,responseMode:'controlled-test'}),{code:'controlled_transport_required'});
  assert.throws(()=>createClaudeInvestigator({env,responseMode:'provider-response'}),{code:'controlled_transport_required'});
});

test('legacy Anthropic path stays one structured call unless tools are explicitly selected', async () => {
  let request;
  const provider = createInvestigationProviders({env:{...env,REFUND_OFFICE_ANTHROPIC_MODE:undefined},responseMode:'controlled-test',fetchImpl:async(_url,init)=>{request=JSON.parse(init.body);return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(good())}]});}});
  assert.equal((await provider.proposeCase(input())).source,'anthropic');
  assert.equal(request.tools,undefined);assert.ok(request.output_config);assert.equal(provider.receipts,undefined);
});

test('two-round investigation reads real snapshot records and hands off only a validated recommendation', async () => {
  const f = fixture({factory:true}), original = input(), before=JSON.stringify(original);
  const result = await f.provider.proposeCase(original);
  assert.deepEqual(result,{...good(),source:'anthropic'}); assert.equal(JSON.stringify(original),before);
  assert.equal(f.calls.length,2); assert.equal(f.calls[0].max_tokens,1000);
  assert.deepEqual(f.calls[0].tools.map(tool=>tool.name),['read_order','read_evidence','submit_recommendation']);
  const returned = f.calls[1].messages.at(-1).content;
  assert.deepEqual(JSON.parse(returned[0].content),original.order);
  assert.deepEqual(JSON.parse(returned[1].content),original.evidence);
  const prepared = prepareInvestigationProposal(result,original,investigationIdentity(f.provider));
  assert.equal(prepared.provenance.mode,'controlled-test'); assert.equal(prepared.provenance.provider,'anthropic');
  const [receipt] = f.provider.receipts(); assert.equal(receipt.status,'completed'); assert.equal(receipt.validation,'passed'); assert.equal(receipt.transport,'controlled-test');
  assert.equal(receipt.requests.length,2);assert.equal(receipt.requests[0].messageId,'msg_fixture_1');assert.equal(receipt.requests[0].requestId,'req_fixture_1');assert.equal(receipt.requests[0].model,'claude-returned-fixture');
  assert.deepEqual(receipt.usage,{inputTokens:200,outputTokens:40,cacheCreationInputTokens:0,cacheReadInputTokens:0});
  assert.deepEqual(receipt.tools.map(tool=>[tool.name,tool.status]),[['read_order','completed'],['read_evidence','completed'],['submit_recommendation','completed']]);
  assert.match(receipt.inputHash,/^[a-f0-9]{64}$/);assert.ok(Date.parse(receipt.finishedAt)>=Date.parse(receipt.startedAt));
  receipt.tools[0].name='changed';assert.equal(f.provider.getReceipts()[0].tools[0].name,'read_order');
  assert.equal(f.provider.capabilities().payments,'disabled');
});

for (const [name,proposal] of [['wrong amount',{...good(),amountMinor:999}],['invented citation',{...good(),evidenceIds:['order:LANG-O1','packing:LANG-O1','invented:id']}],['duplicate citation',{...good(),evidenceIds:['order:LANG-O1','packing:LANG-O1','packing:LANG-O1']}],['approval injection',{...good(),approved:true}]]) test(`rejects ${name} without a retry`,async()=>{
  const f=fixture({factory:true,outputs:[readCalls(),[call('submit_recommendation',proposal)]]});
  await assert.rejects(f.provider.proposeCase(input()));assert.equal(f.calls.length,2);assert.equal(f.provider.receipts()[0].status,'failed');assert.equal(f.provider.receipts()[0].validation,'failed');
});

test('factory applies existing conservative claim and clarification validation',async()=>{
  const f=fixture({factory:true});const original=input();original.complaint='The sketchbook is not missing.';
  await assert.rejects(f.provider.proposeCase(original),{code:'invalid_investigation_proposal'});assert.equal(f.provider.receipts()[0].validation,'failed');
});

for(const [name,calls] of [
  ['payment tool',[call('create_refund',{})]],['arbitrary source fetch',[call('fetch_url',{url:'https://private.invalid'})]],['order arguments',[call('read_order',{orderId:'FOREIGN'})]],['foreign evidence',[call('read_evidence',{ids:['foreign:id']})]],['duplicate requested evidence',[call('read_evidence',{ids:['order:LANG-O1','order:LANG-O1']})]],['duplicate tool ID',[call('read_order',{},'same_id'),call('read_evidence',{ids:['order:LANG-O1']},'same_id')]],
])test(`rejects ${name} at the tool boundary`,async()=>{
  const f=fixture({outputs:[calls]});await assert.rejects(f.provider.proposeCase(input()),{code:'invalid_investigation_tool'});assert.equal(f.calls.length,1);assert.equal(f.provider.receipts()[0].status,'failed');
});

test('duplicate evidence IDs in a caller snapshot fail before any request',async()=>{
  const f=fixture(),value=input();value.evidence.push(value.evidence[0]);
  await assert.rejects(f.provider.proposeCase(value),{code:'invalid_investigation_input'});assert.equal(f.calls.length,0);
});

test('final recommendation cannot precede completed read results or skip safety context',async()=>{
  for(const outputs of [[[call('submit_recommendation',good())]],[readCalls().concat(call('submit_recommendation',good()))],[[call('read_order',{}),call('read_evidence',{ids:['order:LANG-O1','packing:LANG-O1']})],[call('submit_recommendation',good())]]]){
    const f=fixture({outputs});await assert.rejects(f.provider.proposeCase(input()));assert.equal(f.provider.receipts()[0].validation,'failed');
  }
});

test('tool IDs cannot be reused in a later response',async()=>{
  const f=fixture({outputs:[readCalls(),[call('submit_recommendation',good(),'tool_read_order')]]});await assert.rejects(f.provider.proposeCase(input()),{code:'invalid_investigation_tool'});
});

test('request count, tool count and aggregate usage are bounded',async()=>{
  for(const [extra,code]of [[{maxRounds:1},'investigation_round_limit'],[{maxToolCalls:2},'investigation_tool_limit'],[{maxUsageTokens:119},'investigation_usage_limit']]){
    const f=fixture({extra});await assert.rejects(f.provider.proposeCase(input()),{code});assert.equal(f.provider.receipts()[0].status,'failed');
  }
});

test('deadline bounds a transport that ignores its abort signal',async()=>{
  let attempts=0;
  const provider=createClaudeInvestigator({env,responseMode:'controlled-test',deadlineMs:15,fetchImpl:()=>{attempts++;return new Promise(()=>{});}});
  await assert.rejects(provider.proposeCase(input()),{code:'investigation_deadline'});assert.equal(attempts,1);assert.equal(provider.receipts()[0].errorCode,'investigation_deadline');
});

test('expired whole-run clock prevents a second round',async()=>{
  let clock=0,attempts=0;
  const provider=createClaudeInvestigator({env,responseMode:'controlled-test',now:()=>clock,fetchImpl:async()=>{attempts++;clock=20001;return response(readCalls());}});
  await assert.rejects(provider.proposeCase(input()),{code:'investigation_deadline'});assert.equal(attempts,1);
});

test('refusal, truncation and missing usage are explicit failures with no fallback',async()=>{
  for(const [extra,code]of [[{stop_reason:'refusal'},'analysis_refused'],[{stop_reason:'max_tokens'},'analysis_incomplete'],[{usage:null},'anthropic_invalid_response']]){
    const f=fixture({outputs:[response([],1,extra)]});await assert.rejects(f.provider.proposeCase(input()),{code});assert.equal(f.calls.length,1);
  }
});

test('network and HTTP failures never retain raw provider bodies, messages or credentials',async()=>{
  for(const fetchImpl of [async()=>{throw new Error(privateText+' '+env.ANTHROPIC_API_KEY);},async()=>new Response(privateText+' '+env.ANTHROPIC_API_KEY,{status:429})]){
    const provider=createClaudeInvestigator({env,responseMode:'controlled-test',fetchImpl});
    await assert.rejects(provider.proposeCase(input()),error=>!error.message.includes(privateText)&&!error.message.includes(env.ANTHROPIC_API_KEY));
    const saved=JSON.stringify(provider.receipts());assert.ok(!saved.includes(privateText));assert.ok(!saved.includes(env.ANTHROPIC_API_KEY));
  }
});

test('receipt contains operation metadata without customer text, source URLs or model commentary',async()=>{
  const f=fixture({outputs:[[...readCalls(),{type:'text',text:'PRIVATE hidden commentary '+env.ANTHROPIC_API_KEY}],[call('submit_recommendation',{...good(),reason:privateText})]]});
  await f.provider.proposeCase(input());const saved=JSON.stringify(f.provider.receipts());
  assert.doesNotMatch(saved,/PRIVATE|https:|sketchbook|Packing omits|read-only tools/);assert.ok(!saved.includes(env.ANTHROPIC_API_KEY));
  assert.ok(!JSON.stringify(f.calls[1].messages).includes('PRIVATE hidden commentary'));
});

test('provider metadata cannot smuggle a credential into a receipt',async()=>{
  for(const payload of [response(readCalls(),1,{model:env.ANTHROPIC_API_KEY}),response([call('read_order',{},'tool_'+env.ANTHROPIC_API_KEY)])]){
    const f=fixture({outputs:[payload]});await assert.rejects(f.provider.proposeCase(input()));assert.ok(!JSON.stringify(f.provider.receipts()).includes(env.ANTHROPIC_API_KEY));
  }
});
