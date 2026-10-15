const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export class EvidenceClarificationError extends Error {
  constructor(code,message,uncertain=false){super(message);this.name='EvidenceClarificationError';this.code=code;this.uncertain=uncertain;}
}
const invalid=()=>{throw new EvidenceClarificationError('invalid_runtime_input','Supply an existing item, the exact case revision, a customer statement, source reference and recording reason.');};
const unverified=(write=false)=>{throw new EvidenceClarificationError('unverified_runtime_response','The saved clarification could not be independently verified. Keep its original command and inspect the case.',write);};
const text=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>0;
const fields=['lineId','customerStatement','sourceReference','note','expectedRevision','commandId'];
export function clarificationInput(input){
  if(!object(input)||Object.keys(input).length!==fields.length||Object.keys(input).some(k=>!fields.includes(k))||!ID.test(input.lineId||'')||!revision(input.expectedRevision)||!UUID.test(input.commandId||'')||!text(input.customerStatement,10,4000)||!text(input.sourceReference,10,200)||!text(input.note,10,2000))invalid();
  return structuredClone(input);
}
function validSubmission(v){return object(v)&&UUID.test(v.id||'')&&UUID.test(v.commandId||'')&&v.kind==='customer-clarification'&&ID.test(v.lineId||'')&&text(v.body,10,4000)&&text(v.sourceReference,10,200)&&text(v.note,10,2000)&&revision(v.expectedRevision)&&UUID.test(v.actor||'')&&Number.isFinite(Date.parse(v.at));}
export function clarificationContext(value,{tenantId,caseId}){
  if(!object(value)||value.tenantId!==tenantId||value.caseId!==caseId||!revision(value.revision)||typeof value.eligible!=='boolean'||value.paymentSubmission!==false||!text(value.originalComplaint,8,4000)||!(value.requestNote===null||text(value.requestNote,10,2000))||value.eligible&&value.blockedReason!==null||!value.eligible&&!text(value.blockedReason,1,500)||!Array.isArray(value.lines)||!value.lines.length||!Array.isArray(value.submissions)||value.submissions.length>10)unverified();
  const ids=new Set();for(const line of value.lines){if(!object(line)||!ID.test(line.id||'')||ids.has(line.id)||!text(line.name,1,200)||!Number.isSafeInteger(line.ordered)||line.ordered<1||!Number.isSafeInteger(line.packed)||line.packed<0||line.packed>line.ordered||!Number.isSafeInteger(line.unitAmountMinor)||line.unitAmountMinor<0)unverified();ids.add(line.id);}
  const commands=new Set();for(const s of value.submissions){if(!validSubmission(s)||!ids.has(s.lineId)||commands.has(s.commandId)||s.expectedRevision>=value.revision)unverified();commands.add(s.commandId);}
  return structuredClone(value);
}
export async function verifyClarificationWrite(value,input,{tenantId,caseId,actor,readContext,readCase}){
  if(!object(value)||!validSubmission(value.submission)||!object(value.case)||value.case.id!==caseId||value.case.revision!==input.expectedRevision+1||typeof value.replayed!=='boolean')unverified(true);
  const matches=s=>validSubmission(s)&&s.commandId===input.commandId&&s.lineId===input.lineId&&s.body===input.customerStatement&&s.sourceReference===input.sourceReference&&s.note===input.note&&s.expectedRevision===input.expectedRevision&&(!actor||s.actor===actor);
  if(!matches(value.submission))unverified(true);
  let context,saved;try{context=clarificationContext(await readContext(),{tenantId,caseId});saved=await readCase();}catch{unverified(true);}
  const found=context.submissions.find(s=>s.id===value.submission.id);
  if(!matches(found)||JSON.stringify(found)!==JSON.stringify(value.submission)||context.revision<value.case.revision||saved?.id!==caseId||saved.revision<context.revision)unverified(true);
  return {...value,submission:found,case:saved,context,readbackVerified:true};
}
