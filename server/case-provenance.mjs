import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const plain=value=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,''):'';
const money=value=>Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(value/100):'amount not established';
const columns=[['sources','Source records'],['investigation','Investigation'],['policy','Saved policy checks'],['decision','Human decision'],['destinations','Results and destinations']];

// This is a record map, not a reconstruction of an agent's private reasoning.
// References are quoted identifiers. Nothing here fetches a URL or adds facts.
export function buildCaseProvenance(packet){
  const item=packet?.case;
  if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(item.id)||!Number.isSafeInteger(item.revision)||item.revision<0)throw new TypeError('Use a saved case and its exact revision.');
  const nodes=[],edges=[],base='/api/cases/'+encodeURIComponent(item.id);
  const ref=(type,id)=>({type,id:String(id)});
  function node(kind,key,title,text,state,column,refs=[],links=[]){const id=kind+'-'+hash(key).slice(0,20);if(nodes.some(n=>n.id===id))throw new TypeError('Duplicate saved provenance reference.');const full=plain(text),excerpt=full.length>5000;nodes.push({id,kind,title:plain(title),text:excerpt?full.slice(0,5000)+'\n[Excerpt; use the saved case export for the complete record.]':full,state,column,refs,links,...(excerpt?{excerpt:true,sourceHash:hash(full)}:{})});return id;}
  function edge(from,to,label,state='saved'){if(from===to)return;const id='edge-'+hash([from,to,label].join(':')).slice(0,20);if(!edges.some(e=>e.id===id))edges.push({id,from,to,label,state});}
  const caseRef=ref('case-revision',item.id+':'+item.revision);
  const complaint=node('complaint',item.id,'Original customer complaint',plain(item.complaint)||'No customer complaint is present in this saved record.','saved','sources',[caseRef,ref('complaint',item.id)]);
  const evidence=Array.isArray(item.evidence)?item.evidence:[],cited=new Set(Array.isArray(item.proposal?.evidenceIds)?item.proposal.evidenceIds:[]),evidenceNodes=new Map();
  for(const entry of evidence){if(typeof entry?.id!=='string')throw new TypeError('A saved evidence reference is required.');
    const clarification=entry.kind==='customer-clarification';
    const details=[`Saved reference: ${entry.id}`,`Recorded source: ${plain(entry.source)||'Source not recorded.'}`,clarification?'Customer clarification recorded later; the original complaint is unchanged.':null,
      entry.sourceReference?`Source reference (text only): ${plain(entry.sourceReference)}`:null,entry.actor?`Recorded by: ${plain(entry.actor)}`:null,entry.at?`Recorded at: ${plain(entry.at)}`:null,
      plain(entry.displayBody)||plain(entry.body)||'No text body is present.'].filter(Boolean).join('\n');
    const id=node('evidence',entry.id,plain(entry.title)||(clarification?'Recorded customer clarification':'Saved evidence'),details,'saved','sources',[ref('evidence',entry.id),...(entry.sourceReference?[ref('source-reference',entry.sourceReference)]:[])]);evidenceNodes.set(entry.id,id);
  }
  const proposal=item.proposal,source=proposal?.source;
  const investigation=node('investigation',item.id,'Saved investigation',proposal?`${source==='local'?'Local analyser; no model call is implied.':source==='openai'||source==='anthropic'?`Saved ${source} proposal.`:'Analyser identity is not established by this record.'}\n${plain(proposal.reason)||'No investigation reason was saved.'}`:'No completed investigation proposal is saved.',proposal?'saved':'waiting','investigation',[caseRef,...(proposal?.id?[ref('proposal',proposal.id)]:[])]);
  edge(complaint,investigation,proposal?'Complaint attached to saved investigation':'Available complaint for investigation',proposal?'saved':'available');
  for(const [id,nodeId] of evidenceNodes)edge(nodeId,investigation,cited.has(id)?'Cited by the saved proposal':'Gathered record; not cited by the saved proposal',proposal?'saved':'available');
  const unknownCitations=[...cited].filter(id=>!evidenceNodes.has(id));
  if(unknownCitations.length)nodes.find(n=>n.id===investigation).text+='\nUnresolved saved evidence references: '+unknownCitations.join(', ')+'.';
  const recommendation=node('recommendation',item.id,'Recommendation',proposal?`${money(item.proposedAmountMinor??proposal.amountMinor)}. Issue: ${plain(proposal.issue)||'Not established'}.\n${plain(proposal.reason)||'No saved reason.'}\nThis recommendation does not approve a refund.`:'No recommendation is saved.',''+(proposal?'saved':'waiting'),'investigation',[caseRef,...(proposal?.lineId?[ref('order-line',proposal.lineId)]:[])]);
  edge(investigation,recommendation,proposal?'Saved proposal':'Recommendation pending',proposal?'saved':'waiting');
  const checks=Array.isArray(item.checks)?item.checks:[],policyNodes=[];
  for(const [index,check] of checks.entries()){
    const status=check.pass===true||check.status==='pass'?'Passed':check.pass===false||check.status==='hold'?'Held':plain(check.status)||'Result not established';
    const id=node('policy',String(check.id??index),plain(check.label)||'Saved policy check',`${status}. ${plain(check.detail)}\nSaved check included in this case snapshot; not a current payment result.`,'saved','policy',[...(check.id?[ref('policy-check',check.id)]:[caseRef]),...(check.policyVersion?[ref('policy-version',check.policyVersion)]:[])]);policyNodes.push(id);edge(recommendation,id,'Saved check associated with recommendation');
  }
  if(!checks.length)policyNodes.push(node('policy','pending','Policy checks','No policy check results are saved.','waiting','policy',[caseRef]));
  const approval=item.approval,review=item.review;
  const recordedApproval=approval&&approval.state==='approved',recordedReview=review&&typeof review.state==='string';
  const humanText=recordedApproval?`Approval recorded for ${money(approval.amountMinor)}.\nActor: ${plain(approval.actor||approval.reviewer)||'Not recorded'}\nAt: ${plain(approval.decidedAt||approval.at)||'Not recorded'}\nReason: ${plain(approval.note)||'Not recorded'}`:recordedReview?`Review state: ${plain(review.state)}.\nActor: ${plain(review.actor||review.reviewer)||'Not recorded'}\nAt: ${plain(review.decidedAt||review.at)||'Not recorded'}\nReason: ${plain(review.note)||'Not recorded'}${review.state==='awaiting-evidence'?'\nInternal evidence request only; no customer message was sent.':''}`:approval?.state==='invalidated'?`Prior approval invalidated. ${plain(approval.reason)} A new human decision is required.`:'No current refund approval or review decision is attached to this case state; earlier decisions may remain in recorded history. A recommendation or passed check is not approval.';
  const alreadyResolved=item.outcome==='already-resolved';
  const human=node('review',item.id,recordedApproval?'Recorded approval':recordedReview?'Recorded human review':alreadyResolved?'No new approval recorded':'Human decision pending',humanText,recordedApproval||recordedReview?'saved':alreadyResolved?'available':'waiting','decision',[caseRef,...(recordedApproval&&(approval.id||approval.commandId)?[ref('approval',approval.id||approval.commandId)]:[]),...(recordedApproval&&approval.policyVersion?[ref('approval-policy-version',approval.policyVersion)]:[]),...(recordedReview&&(review.id||review.commandId)?[ref('review',review.id||review.commandId)]:[])]);
  const historicalReviews=[];
  for(const [index,event] of (item.events||[]).entries())if(typeof event?.type==='string'&&event.type.startsWith('review.')){
    historicalReviews.push(node('review','history:'+(event.id??index),'Recorded review history',`Historical event: ${plain(event.type)}. This does not grant current refund approval.\n${plain(event.label)}\n${plain(event.detail)}\nRecorded actor: ${plain(event.actor)||'Not recorded'}\nRecorded at: ${plain(event.at)||'Not recorded'}`,'saved','decision',[caseRef,...(event.id!==undefined?[ref('event',event.id)]:[])]));
  }
  const originalApproval=packet.operation?.approval;
  if(originalApproval?.state==='approved'&&JSON.stringify(originalApproval)!==JSON.stringify(approval))historicalReviews.push(node('review','original-operation-approval','Original operation approval',`Approval saved on the original operation for ${money(originalApproval.amountMinor)}; this is not fresh authority for the current case state.\nActor: ${plain(originalApproval.actor||originalApproval.reviewer)||'Not recorded'}\nReason: ${plain(originalApproval.note)||'Not recorded'}`,'saved','decision',[caseRef,...(packet.operation.id?[ref('operation',packet.operation.id)]:[]),...(originalApproval.id||originalApproval.commandId?[ref('approval',originalApproval.id||originalApproval.commandId)]:[])]));
  for(const id of policyNodes)edge(id,human,recordedApproval||recordedReview?'Saved checks alongside recorded decision':'Checks available to human reviewer',recordedApproval||recordedReview?'saved':'waiting');
  const hosted=packet.mode==='hosted-supabase'||packet.case.paymentExecutionScope==='original-reservation',operation=packet.operation,receipt=operation?.receipt||item.receipt,operationId=operation?.id||item.operationId;
  let paymentTitle='Payment record',paymentState='waiting',paymentText='No payment operation is included in this saved case.';
  if(receipt?.seeded===true){paymentTitle='Seeded historical remedy';paymentState='saved';paymentText=`This is supplied synthetic history, not a new refund.\nReceipt: ${plain(receipt.id)||'Identity not recorded'}\nSaved status: ${plain(receipt.status)||'Not recorded'}.`;}
  else if(operationId){paymentState='saved';paymentText=`Original operation: ${operationId}.\nSaved status: ${plain(operation?.status)||plain(item.outcome)||'Not established'}.`;
    if(item.outcome==='approved-not-submitted'||operation?.status==='reserved')paymentText+='\nAn original reservation is saved; that record is not a completed payment.';
    if(receipt){paymentText+=`\nReceipt: ${plain(receipt.id)||'Identity not recorded'}; saved status: ${plain(receipt.status)||'Not recorded'}.`;if(receipt.provider==='local')paymentText+='\nLocal simulation only; no real money moved.';else if(receipt.provider==='stripe-sandbox'&&receipt.livemode===false)paymentText+='\nSaved Stripe test-mode receipt; not a live payment.';else paymentText+='\nProvider and live/test mode are not established by this map.';}}
  if(hosted){paymentState='unverified';paymentText+='\nSeparate test execution records are not included here. This map does not establish whether a separate refund was submitted or completed.';}
  else if(packet.capabilities?.paymentSubmission===false||packet.paymentSubmissionEnabled===false)paymentText+='\nPayment submission is disabled in this rehearsal.';
  const payment=node('payment',item.id,paymentTitle,paymentText,paymentState,'destinations',[...(operationId?[ref('operation',operationId)]:[]),...(receipt?.id?[ref('receipt',receipt.id)]:[]),caseRef]);
  edge(human,payment,receipt?.seeded?'Historical remedy; not caused by this review':operationId?'Original operation recorded alongside this case':'No new payment is authorised by this map',receipt?.seeded||operationId?'saved':'waiting');
  const report=node('report',item.id,'Decision report available','The report endpoint can generate a report from saved records. This export does not establish that a report was downloaded, sent or published.','available','destinations',[caseRef],[{label:'Decision report',path:base+'/report'}]);
  const packetNode=node('packet',item.id,'Saved case export available','The case export contains saved evidence, references and history. Access follows the current application mode; links open the current saved revision, which may differ from this map’s revision.','available','destinations',[caseRef],[{label:'Saved case record',path:base},{label:'Saved case export',path:base+'/export'}]);
  edge(human,report,'Decision status included when report is generated','available');edge(payment,report,'Payment limitations included in report','available');edge(complaint,packetNode,'Original complaint retained in case export','available');
  for(const history of historicalReviews)edge(history,packetNode,'Recorded review history retained in case export','available');
  const synthetic=packet.synthetic===true||packet.dataMode==='synthetic-orders';
  const localIdentity=packet.mode==='local-postgres-rehearsal'?'Local rehearsal profiles are fictional test identities, not online accounts.':packet.dataMode==='synthetic-orders'?'Local reviewer labels are not authenticated online identities.':null;
  return {schemaVersion:1,format:'refund-office-case-board',mode:'local-export',target:'miro',importReady:false,caseId:item.caseId||item.id,caseRecordId:item.id,revision:item.revision,title:`Case source map: ${plain(item.title)||item.caseId||item.id}`,
    synthetic:synthetic?true:null,linksRequireSession:hosted||packet.mode==='local-postgres-rehearsal',identityScope:localIdentity||(hosted?'Saved actor identifiers; this map does not authenticate its viewer.':'Identity assurance is not established by this export.'),
    publication:{prepared:true,published:false,provider:'miro',publicOriginRequiredForClickableLinks:true},
    provenance:{schemaVersion:1,nodes,edges},columns:columns.map(([id,title])=>({id,title,cards:nodes.filter(n=>n.column===id).map(n=>({id:n.id,title:n.title,text:n.text,state:n.state,refs:n.refs,links:n.links}))})),
    limitations:['No board has been created or uploaded.','Custom local preparation; direct JSON import into Miro is not verified.','Source references are quoted text, never fetched or treated as instructions.','Connections show saved references and available destinations, not hidden reasoning or proof of delivery.','The map does not approve or submit refunds.',...(synthetic?['Synthetic demonstration records only.']:['The source data mode is not established by this export.']),...(localIdentity?[localIdentity]:[]),...(hosted?['Separate payment execution records are not included; their result remains unverified here.']:[])]};
}
