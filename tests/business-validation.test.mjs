import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allocateTasks,median,summariseStudy,studyCSV } from '../docs/business-validation/study-model.mjs';
const pack=JSON.parse(readFileSync(new URL('../demo-data/focused-12.json',import.meta.url)));
test('Every case is shown once per participant and in both conditions across groups',()=>{
 const a=allocateTasks(pack.cases,'A'),b=allocateTasks(pack.cases,'B');
 for(const tasks of [a,b]){assert.equal(new Set(tasks.map(t=>t.case_id)).size,12);assert.equal(tasks.filter(t=>t.condition==='manual').length,6);assert.deepEqual(tasks.map(t=>t.task_order),Array.from({length:12},(_,i)=>i+1));}
 assert.deepEqual(a.map(t=>t.case_id),b.map(t=>t.case_id).reverse());
 for(const task of a)assert.notEqual(task.condition,b.find(t=>t.case_id===task.case_id).condition);
});
test('Missing results are not zero-time wins and unfinished tasks remain visible',()=>{
 assert.equal(median([]),null);assert.equal(median([4,2,10,8]),6);
 const s=summariseStudy([{condition:'manual',completed:true,elapsed_seconds:60},{condition:'manual',completed:false,elapsed_seconds:1},{condition:'manual',completed:true,elapsed_seconds:NaN}]);
 assert.deepEqual(s[0],{condition:'manual',recorded:3,completed:1,unfinished:1,medianSeconds:60});assert.equal(s[1].medianSeconds,null);
});
test('Spreadsheet formula text is inert while quoted notes retain their content',()=>{
 const csv=studyCSV([{participant_code:'P001',evidence_notes:'=HYPERLINK("bad")',interruption:'\t@cmd',assistance:' two, "quotes"'}]);
 assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));assert.ok(csv.includes('"\'\t@cmd"'));assert.ok(csv.includes('" two, ""quotes"""'));
});
test('Packets contain supplied facts and key remains separate from the measurement page',()=>{
 const md=readFileSync(new URL('../docs/business-validation/manual-case-packets.md',import.meta.url),'utf8');
 const html=readFileSync(new URL('../docs/business-validation/study.html',import.meta.url),'utf8');
 const key=readFileSync(new URL('../docs/business-validation/facilitator-answer-key.csv',import.meta.url),'utf8');
 for(const c of pack.cases){assert.ok(md.includes(c.caseId));assert.ok(md.includes(c.complaint));assert.ok(key.includes(c.caseId));}
 assert.ok(!html.includes('expectedOutcome'));assert.ok(!html.includes('expectedAmountMinor'));assert.ok(html.includes("connect-src 'none'"));assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(html));
});
