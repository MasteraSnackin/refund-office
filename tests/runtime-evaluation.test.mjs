import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreRuntimeCase, buildRuntimeScorecard, prepareRuntimeEvaluationRows } from '../server/runtime-evaluation-scorecard.mjs';
import { renderRuntimeScorecards } from '../scripts/evaluate-runtime.mjs';
const dataset=JSON.parse(readFileSync(new URL('../demo-data/focused-12.json',import.meta.url)));
const seed=dataset.cases[0],scenario=dataset.scenarios.find(x=>x.caseId===seed.id),order=dataset.orders.find(x=>x.id===seed.orderId);
function fixture(){
 const c={id:seed.id,caseId:seed.caseId,orderId:seed.orderId,revision:2,outcome:scenario.expectedOutcome,proposedAmountMinor:scenario.expectedAmountMinor,stage:'review',approval:null,receipt:null,operationId:null,
 proposal:{source:'local',lineId:order.lines[0].id,issue:'item_missing',amountMinor:2000,evidenceIds:[`packing:${order.id}`]},evidence:[{id:`packing:${order.id}`}],checks:Array.from({length:7},(_,n)=>({id:`check-${n}`,pass:true})),events:[{type:'investigation.finished',payload:{outcome:scenario.expectedOutcome}}]};
 const span={name:'refund.investigation',status:'OK',traceId:'a'.repeat(32),spanId:'b'.repeat(16),attributes:{synthetic:true,packId:dataset.id,caseId:seed.caseId,'case.revision':2,amountMinor:2000,outcome:scenario.expectedOutcome}};
 return {c,span};
}
const score=(c,span)=>scoreRuntimeCase({dataset,scenario,caseRecord:c,spans:[span]});
test('current runtime scoring links independently saved results to completed investigation spans',()=>{
 const {c,span}=fixture(),result=score(c,span);assert.equal(result.passed,true);assert.equal(result.evaluations.length,10);assert.deepEqual(result.evidenceRefs,[`packing:${order.id}`]);assert.equal(result.spanId,span.spanId);
});
for(const [name,mutate,expected] of [
 ['wrong amount',c=>c.proposedAmountMinor=1999,'exact_amount'],['invented citation',c=>c.proposal.evidenceIds.push('invented'),'evidence_references'],
 ['approval during investigation',c=>c.approval={state:'approved'},'human_approval_boundary'],['new payment record',c=>c.operationId='new','historical_receipt_boundary'],
 ['policy bypass',c=>c.checks[0].pass=false,'policy_stop'],['missing saved finish',c=>c.events=[],'saved_investigation'],['incorrect item',c=>c.proposal.lineId=order.lines[1].id,'item_and_quantity']
])test(`current scorecard detects ${name}`,()=>{const {c,span}=fixture();mutate(c);const result=score(c,span);assert.equal(result.passed,false);assert.equal(result.evaluations.find(x=>x.name===expected).score,0);});
test('changed, duplicate or absent investigation spans cannot establish trace binding',()=>{
 const {c,span}=fixture();assert.equal(score(c,{...span,attributes:{...span.attributes,'case.revision':3}}).passed,false);
 assert.equal(scoreRuntimeCase({dataset,scenario,caseRecord:c,spans:[span,span]}).passed,false);
 assert.equal(scoreRuntimeCase({dataset,scenario,caseRecord:c,spans:[]}).passed,false);
});
test('runtime Arize preparation rejects changed facts and arbitrary explanation text',()=>{
 const {c,span}=fixture(),result=score(c,span),card={kind:'refund-office-runtime-scorecard',synthetic:true,uploaded:false,dataset:{id:dataset.id,cases:1},cases:[result]};
 assert.equal(prepareRuntimeEvaluationRows([card],[span]).rows.length,1);
 assert.throws(()=>prepareRuntimeEvaluationRows([card],[span,span]),/unique/);
 assert.throws(()=>prepareRuntimeEvaluationRows([{...card,cases:[{...result,revision:3}]}],[span]),/does not match/);
 result.evaluations[0].explanation='Customer text';assert.throws(()=>prepareRuntimeEvaluationRows([card],[span]),/altered/);
});
test('incomplete pack coverage and missing counters cannot pass',()=>{
 const {c,span}=fixture(),card=buildRuntimeScorecard({dataset,observations:[c],spans:[span],counters:{},recorder:{}});
 assert.equal(card.passed,false);assert.equal(card.checks.find(x=>x.name==='complete_case_coverage').score,0);assert.equal(card.checks.find(x=>x.name==='externalRequests').score,0);
 const html=renderRuntimeScorecards([card]);assert.match(html,/current application service against a fresh local PostgreSQL/);assert.doesNotMatch(html,/original application engine in a fresh in-memory/);assert.match(html,/observed-cases.json/);
});
