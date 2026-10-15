import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareSyntheticImport } from '../../server/supabase-import.mjs';

// Called only by the explicit disposable PostgreSQL harness after 001. It
// creates separate synthetic tenants and never contacts an account service.
export async function runHostedChecks({ ROOT, sql, value, rejected, check, quote }) {
  const json=entry=>`${quote(JSON.stringify(entry))}::jsonb`,uuid=entry=>`${quote(entry)}::uuid`,text=entry=>`${quote(entry)}::text`;
  const actor=userId=>({role:'authenticated',userId});
  const tenant='70000000-0000-4000-8000-000000000012',otherTenant='70000000-0000-4000-8000-000000000050';
  const reviewer='70000000-0000-4000-8000-000000000001',investigator='70000000-0000-4000-8000-000000000002',otherUser='70000000-0000-4000-8000-000000000003',outsider='70000000-0000-4000-8000-000000000004';
  const pack=prepareSyntheticImport(JSON.parse(readFileSync(join(ROOT,'demo-data/focused-12.json'),'utf8')));
  const context=(selected=tenant)=>`SELECT public.refund_runtime_session_context(${uuid(selected)});`;
  const session=(id,action,generation=1,selected=tenant)=>`SELECT public.refund_runtime_hosted_session(${uuid(selected)},${uuid(id)},${text(action)},${generation}::bigint);`;
  const ledger=(action,input,selected=tenant)=>`SELECT public.refund_runtime_sponsor_action(${uuid(selected)},${text(action)},${json(input)});`;
  await check('hosted access and sponsor journal migrations execute without granting direct table access',async()=>{
    const hashes={};for(const file of ['003_hosted_access.sql','005_sponsor_actions.sql']){const bytes=readFileSync(join(ROOT,'integrations/supabase/runtime',file));await sql(bytes.toString());hashes[file]=createHash('sha256').update(bytes).digest('hex');}
    await sql(`INSERT INTO auth.users(id) VALUES ${[reviewer,investigator,otherUser,outsider].map(id=>`(${uuid(id)})`).join(',')} ON CONFLICT DO NOTHING;`);
    for(const [id,members]of[[tenant,[{userId:reviewer,role:'reviewer'},{userId:investigator,role:'investigator'}]],[otherTenant,[{userId:otherUser,role:'reviewer'}]]])await value(`SELECT public.refund_runtime_import_dataset(${uuid(id)},${json(pack.data)},${text(pack.manifest.digest)},${json(members)});`);
    for(const table of ['hosted_sessions','sponsor_actions'])for(const role of ['anon','authenticated','service_role'])await rejected(`SELECT * FROM refund_runtime.${table};`,{role,userId:reviewer},/42501/);
    return {hashes,directAccess:'denied',providerTokensStored:false};
  });
  await check('hosted membership derives the verified user and denies anonymous and cross-tenant callers',async()=>{
    const r=await value(context(),actor(reviewer));assert.equal(r.userId,reviewer);assert.equal(r.role,'reviewer');assert.equal(r.synthetic,true);
    assert.equal((await value(context(),actor(investigator))).role,'investigator');
    for(const caller of [{role:'anon'},actor(outsider),actor(otherUser),{...actor(reviewer),anonymous:true}])await rejected(context(),caller,/42501/);
    await rejected(context(otherTenant),actor(reviewer),/42501/);
    return {verifiedRoles:['reviewer','investigator'],tenantIsolation:true};
  });
  await check('durable hosted sessions enforce actor, generation rotation, expiry and revocation',async()=>{
    const id=randomUUID(),created=await value(session(id,'create'),actor(reviewer));assert.equal(created.generation,1);assert.equal(created.revoked,false);
    await rejected(session(id,'check'),actor(investigator),/42501/);
    assert.equal((await value(session(id,'check'),actor(reviewer))).sessionId,id);
    assert.equal((await value(session(id,'rotate'),actor(reviewer))).generation,2);
    await rejected(session(id,'check',1),actor(reviewer),/42501/);await rejected(session(id,'rotate',1),actor(reviewer),/42501/);
    const revoked=await value(session(id,'revoke',1),actor(reviewer));assert.equal(revoked.revoked,true);assert.equal(revoked.generation,2);
    assert.deepEqual(await value(session(id,'revoke',1),actor(reviewer)),revoked);
    await rejected(session(id,'revoke',3),actor(reviewer),/42501/);
    await rejected(session(id,'check',2),actor(reviewer),/42501/);await rejected(session(id,'rotate',2),actor(reviewer),/42501/);
    const expired=randomUUID();await value(session(expired,'create'),actor(reviewer));
    await sql(`UPDATE refund_runtime.hosted_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=${uuid(tenant)} AND id=${uuid(expired)};`);
    await rejected(session(expired,'check'),actor(reviewer),/42501/);
    const changedRole=randomUUID();await value(session(changedRole,'create'),actor(reviewer));
    await sql(`UPDATE refund_runtime.memberships SET role='investigator' WHERE tenant_id=${uuid(tenant)} AND user_id=${uuid(reviewer)};`);
    assert.equal((await value(session(changedRole,'check'),actor(reviewer))).role,'investigator');
    await sql(`UPDATE refund_runtime.memberships SET role='reviewer' WHERE tenant_id=${uuid(tenant)} AND user_id=${uuid(reviewer)};`);
    return {staleGeneration:'denied',revokedCookie:'denied',expiredSession:'denied',roleChanges:'read-fresh'};
  });
  const caseId=pack.data.cases[0].id,key='a'.repeat(64),commandId=randomUUID(),payloadHash='b'.repeat(64);
  const entry={key,caseId,revision:1,action:'port',commandId,payloadHash};
  await check('sponsor commands reserve once and preserve canonical key and payload across conflicting retries',async()=>{
    const results=await Promise.all([value(ledger('begin',entry),actor(reviewer)),value(ledger('begin',entry),actor(investigator))]);
    assert.equal(results.filter(r=>r.created).length,1);assert.ok(results.every(r=>r.record.key===key));
    const changed=await value(ledger('begin',{...entry,key:'c'.repeat(64),payloadHash:'d'.repeat(64)}),actor(reviewer));
    assert.equal(changed.created,false);assert.equal(changed.record.key,key);assert.equal(changed.record.payloadHash,payloadHash);
    await rejected(ledger('begin',{...entry,key:'e'.repeat(64),commandId:randomUUID(),revision:2}),actor(reviewer),/40001/);
    await rejected(ledger('begin',{...entry,key:'e'.repeat(64),commandId:randomUUID(),action:'approve'}),actor(reviewer),/22023/);
    return {createdOnce:true,commandCollision:'original-preserved',staleCase:'denied'};
  });
  await check('sponsor journal readback is tenant scoped and unknown writes cannot reset to pending',async()=>{
    let row=await value(ledger('update',{key,state:'unknown',result:null,errorCode:'write_unconfirmed'}),actor(reviewer));assert.equal(row.state,'unknown');
    await rejected(ledger('update',{key,state:'pending',result:null,errorCode:null}),actor(reviewer),/22023/);
    await rejected(ledger('update',{key,state:'acknowledged',result:{id:'remote-fixture'},errorCode:null}),actor(reviewer),/55000/);
    row=await value(ledger('update',{key,state:'succeeded',result:{verified:true,identifier:'fixture-service'},errorCode:null}),actor(investigator));assert.equal(row.result.verified,true);
    assert.deepEqual(await value(ledger('update',{key,state:'succeeded',result:row.result,errorCode:null}),actor(reviewer)),row);
    await rejected(ledger('update',{key,state:'succeeded',result:{verified:true,identifier:'changed'},errorCode:null}),actor(reviewer),/55000/);
    await rejected(ledger('update',{key,state:'succeeded',result:null,errorCode:null}),actor(reviewer),/55000/);
    await rejected(ledger('update',{key,state:'unknown',result:null,errorCode:null}),actor(reviewer),/55000/);
    assert.equal((await value(ledger('get',{key}),actor(reviewer))).state,'succeeded');
    assert.equal((await value(ledger('list',{caseId,revision:1}),actor(reviewer))).length,1);
    await rejected(ledger('get',{key}),actor(otherUser),/42501/);await rejected(ledger('list',{caseId,revision:1}),actor(outsider),/42501/);
    await rejected(ledger('update',{key,state:'succeeded',result:{},errorCode:'unsafe-code'}),actor(reviewer),/22023/);
    const untouched=await value(`SELECT jsonb_build_object('revision',revision,'approval',approval,'operationId',operation_id) FROM refund_runtime.cases WHERE tenant_id=${uuid(tenant)} AND id=${text(caseId)};`);
    assert.deepEqual(untouched,{revision:1,approval:null,operationId:null});
    return {unknownReplay:'blocked',independentReadback:true,paymentAuthority:false};
  });
  await check('acknowledged sponsor identities survive uncertainty and terminal results are immutable',async()=>{
    const cardKey='f'.repeat(64),card={...entry,key:cardKey,action:'miro-card-'+('1'.repeat(24)),commandId:randomUUID()};
    await value(ledger('begin',card),actor(reviewer));
    const identity={id:'fixture-note',boardId:'fixture-board',expectedContent:'Saved case summary'};
    await value(ledger('update',{key:cardKey,state:'acknowledged',result:identity,errorCode:null}),actor(reviewer));
    const unknown=await value(ledger('update',{key:cardKey,state:'unknown',result:null,errorCode:'readback_unavailable'}),actor(reviewer));assert.deepEqual(unknown.result,identity);
    for(const result of [{...identity,id:'another'}, {id:identity.id,boardId:identity.boardId}, {...identity,boardId:'another'}, {...identity,expectedContent:'rewritten'}])await rejected(ledger('update',{key:cardKey,state:'succeeded',result,errorCode:null}),actor(reviewer),/55000/);
    const completed=await value(ledger('update',{key:cardKey,state:'succeeded',result:{...identity,verified:true},errorCode:null}),actor(reviewer));
    assert.deepEqual(await value(ledger('update',{key:cardKey,state:'succeeded',result:completed.result,errorCode:null}),actor(investigator)),completed);
    const rejectKey='9'.repeat(64);await value(ledger('begin',{...entry,key:rejectKey,commandId:randomUUID()}),actor(reviewer));
    const rejectedRow=await value(ledger('update',{key:rejectKey,state:'rejected',result:null,errorCode:'provider_rejected'}),actor(reviewer));
    assert.deepEqual(await value(ledger('update',{key:rejectKey,state:'rejected',result:null,errorCode:'provider_rejected'}),actor(investigator)),rejectedRow);
    await rejected(ledger('update',{key:rejectKey,state:'rejected',result:{changed:true},errorCode:'provider_rejected'}),actor(reviewer),/55000/);
    await rejected(ledger('update',{key:rejectKey,state:'rejected',result:null,errorCode:'changed'}),actor(reviewer),/55000/);
    return {unknownPreservesIdentity:true,terminalReplay:'exact-only',completedRows:'unchanged'};
  });
}
