export const studyColumns = ['participant_code','group','task_order','case_id','condition','elapsed_seconds','completed','outcome','amount_minor','evidence_notes','confidence','interruption','assistance'];
export function allocateTasks(cases, group) {
  if(!['A','B'].includes(group)||!Array.isArray(cases)||cases.length!==12||new Set(cases.map(x=>x.caseId)).size!==12)throw new Error('Choose group A or B with the twelve distinct synthetic cases.');
  const tasks=cases.map((c,i)=>({case_id:c.caseId,sourceId:c.id,condition:(i%2===0)===(group==='A')?'manual':'assisted'}));
  if(group==='B')tasks.reverse();
  return tasks.map((t,i)=>({...t,task_order:i+1}));
}
export function median(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;}
export function summariseStudy(rows){return ['manual','assisted'].map(condition=>{const all=rows.filter(r=>r.condition===condition);const done=all.filter(r=>r.completed===true&&Number.isFinite(r.elapsed_seconds)&&r.elapsed_seconds>=0);return {condition,recorded:all.length,completed:done.length,unfinished:all.filter(r=>r.completed===false).length,medianSeconds:median(done.map(r=>r.elapsed_seconds))};});}
export function studyCSV(rows){const cell=value=>{let s=value==null?'':String(value);if(/^[\s]*[=+\-@]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return [studyColumns,...rows.map(r=>studyColumns.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';}
