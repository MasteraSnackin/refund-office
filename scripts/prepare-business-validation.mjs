import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(root,'docs/business-validation');mkdirSync(out,{recursive:true});
const pack=JSON.parse(readFileSync(resolve(root,'demo-data/focused-12.json'),'utf8'));
const money=n=>'£'+(n/100).toFixed(2);
const lines=['# Manual review packets','','Synthetic supplied records. Each packet is one review task; the scenario names and answers are omitted. Keep the facilitator key separate. No worksheet answer approves a refund.','','Policy version '+pack.policy.version+': supported missing-item recommendations up to '+money(pack.policy.limitMinor)+' may be prepared for human approval. Above-limit, ambiguous, disputed or unsupported cases stay on hold. An exact existing remedy must not produce a new refund.',''];
for(const item of pack.cases){const order=pack.orders.find(o=>o.id===item.orderId);const history=pack.seedOperations.filter(o=>o.orderId===order.id);lines.push('## '+item.caseId,'','Order '+order.id+' · total '+money(order.totalMinor),'','Customer statement: '+item.complaint,'','| Item | Ordered | Packed | Unit price |','| --- | ---: | ---: | ---: |',...order.lines.map(l=>`| ${l.name} | ${l.ordered} | ${l.packed} | ${money(l.unitAmountMinor)} |`),'','Delivery: '+order.delivery.status+'. Disputed: '+(order.delivery.disputed?'yes':'no')+'. '+order.delivery.detail,'','Supplied historical remedies: '+(history.length?history.map(h=>`${h.receipt.id}: ${money(h.amountMinor)} for ${order.lines.find(l=>l.id===h.lineId)?.name}. Explicitly seeded demonstration history, not a new payment.`).join(' '):'none.'),'','Record an outcome (ready for human review, hold, or existing remedy), the relevant amount and the evidence supporting your answer.','');}
writeFileSync(resolve(out,'manual-case-packets.md'),lines.join('\n'));
const csv=[['case_id','outcome','amount_minor','category','note'],...pack.scenarios.map(s=>[pack.cases.find(c=>c.id===s.caseId).caseId,s.expectedOutcome,s.expectedAmountMinor,s.category,s.expectedOutcome==='already-resolved'?'Historical amount only; no new payment':s.expectedOutcome==='held'?'Hold even if an item value is established':'Supported recommendation still requires approval'])].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
writeFileSync(resolve(out,'facilitator-answer-key.csv'),csv);
const template=readFileSync(resolve(out,'study.template.html'),'utf8');
const model=readFileSync(resolve(out,'study-model.mjs'),'utf8').replace(/^export /gm,'');
const data=JSON.stringify(pack.cases.map(({id,caseId})=>({id,caseId}))).replaceAll('<','\\u003c');
writeFileSync(resolve(out,'study.html'),template.replace('/* MODEL */',model).replace('/* CASES */','const cases='+data+';'));
console.log('Prepared twelve source-backed packets, separate answer key and local timing worksheet. No external request or customer measurement.');
