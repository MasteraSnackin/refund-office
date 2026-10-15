import { createHash } from 'node:crypto';
import { createSponsorClients, planMiroNotes, planMiroConnectors, resolveMiroConnector } from './sponsor-clients.mjs';
import { createElevenLabs } from './elevenlabs.mjs';

export class SponsorActionError extends Error {
  constructor(code, message, { status = 409, uncertain = false } = {}) { super(message); this.name = 'SponsorActionError'; this.code = code; this.status = status; this.uncertain = uncertain; }
}
const fail = (code, message, options) => { throw new SponsorActionError(code, message, options); };
const errorCode = error => /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'provider_unconfirmed';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const cleanRecord = record => ({ action: record.action, state: record.state, commandId: record.commandId, updatedAt: record.updatedAt, errorCode: record.errorCode, verified: record.result?.verified === true, remoteId: record.result?.id || record.result?.identifier || null, ...(record.result?.itemKind?{itemKind:record.result.itemKind}:{}),...(record.result?.counts?{counts:record.result.counts}:{}) });
const requirements = {
  voice: ['ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID'],
  miro: ['MIRO_ACCESS_TOKEN','MIRO_BOARD_ID'],
  modal: ['MODAL_EVIDENCE_URL','MODAL_EVIDENCE_TOKEN'],
  port: ['PORT_API_URL','PORT_BLUEPRINT_ID','PORT_ACCESS_TOKEN'],
};
const provider = action => action === 'voice' ? 'elevenlabs' : action;

// getPacket/getBriefing/getBoard must be access-scoped by the host. This facade
// does not mutate cases, evidence, decisions or financial operations.
export function createSponsorActions({ env = {}, clients, voice, ledger, getPacket, getBriefing, getBoard } = {}) {
  if (typeof getPacket !== 'function') throw new TypeError('Provide an access-scoped saved-packet reader.');
  const network = env.REFUND_OFFICE_NETWORK === 'enabled';
  const enabled = new Set(String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(x => x.trim()));
  // Do not read voice credentials merely by constructing an offline facade.
  const outbound = clients || createSponsorClients({ env });
  let speech = voice;
  const ready = action => {
    if (!network || !enabled.has(provider(action))) return { configured: false, reason: 'Disconnected. No external request will be sent.' };
    if (!ledger?.durable) return { configured: false, reason: 'A durable action ledger must be configured before using this service.' };
    if (!requirements[action].every(name => typeof env[name] === 'string' && env[name].trim() && !/[\r\n]/.test(env[name]))) return { configured: false, reason: 'Server configuration is incomplete. No provider request has been made.' };
    return { configured: true, reason: 'Configured, but live access has not been verified. Actions use saved case data.' };
  };
  const gate = action => { const state = ready(action); if (!state.configured) fail('integration_disconnected', state.reason, { status: 503 }); };
  async function context(principal, caseId, expectedRevision) {
    if (!principal?.tenantId || !principal?.userId || !['reviewer','investigator'].includes(principal.role)) fail('session_required','A signed-in workspace member is required.',{status:401});
    const packet = await getPacket(principal, caseId);
    if (!packet?.case || packet.case.id !== caseId || packet.tenantId !== principal.tenantId) fail('case_access_denied','This saved case is not available in your workspace.',{status:403});
    const revision = packet.case.revision;
    if (!Number.isSafeInteger(revision) || revision < 1 || (expectedRevision !== undefined && expectedRevision !== revision)) fail('stale_case','The case changed. Inspect its saved revision before starting a new action.');
    return { packet, tenantId: principal.tenantId, caseId, revision };
  }
  async function begin(ctx, action, body, payload, resource = '') {
    if (!uuid(body?.commandId)) fail('command_required','A stable command identity is required.',{status:400});
    const key = hash([ctx.tenantId,ctx.caseId,ctx.revision,action,resource]);
    const payloadHash = hash(payload);
    const start = await ledger.begin({ key, tenantId:ctx.tenantId,caseId:ctx.caseId,revision:ctx.revision,action,commandId:body.commandId,payloadHash });
    if (start.record.key !== key || start.record.payloadHash !== payloadHash) fail('command_conflict','This action identity is already bound to different saved data.');
    if (!start.created && start.record.state !== 'succeeded') fail('action_unconfirmed','A previous attempt is saved but not verified. Use readback where available; do not post it again.',{uncertain:true});
    return { ...start, key };
  }
  const changed = async (principal,ctx) => context(principal,ctx.caseId,ctx.revision);
  const uncertain = async (key,error,result=null) => { await ledger.update(key,{state:'unknown',result,errorCode:errorCode(error)}); throw new SponsorActionError(errorCode(error),error instanceof SponsorActionError ? error.message : 'The provider result could not be confirmed. The saved action is blocked from reposting until its status can be checked.',{status:error.status || 502,uncertain:true}); };
  const summary = async ctx => (ledger?.durable ? await ledger.list(ctx) : []).map(cleanRecord);
  function requireRevision(body) { if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 1) fail('revision_required','Specify the saved case revision.',{status:400}); }
  async function prepare(principal,caseId,body,action) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expectedRevision','commandId',...(action==='modal'?['evidenceId']:[])].includes(key))) fail('invalid_action','Provide only the documented action fields.',{status:400}); requireRevision(body); const ctx=await context(principal,caseId,body.expectedRevision); gate(action); return ctx; }
  const service = { identifier: 'refund-office', title: 'Refund Office', status: 'configured-unverified' };
  const portMatch = result => result?.identifier===service.identifier && result.title===service.title && result.properties?.readiness===service.status && result.properties.humanApprovalRequired===true && result.properties.liveVerified===false;
  const connectorMatch=(read,body)=>read?.startItemId===body?.startItem?.id&&read?.endItemId===body?.endItem?.id&&read?.shape===body?.shape&&JSON.stringify(read?.captions)===JSON.stringify(body?.captions?.map(c=>c.content));
  const publicMiroReceipt=receipt=>{const {expectedContent,expectedConnector,...publicReceipt}=receipt;return publicReceipt;};
  return {
    async status(principal,caseId) {
      const ctx=await context(principal,caseId);
      return {caseId,revision:ctx.revision,mode:network?'external-enabled':'offline',paymentSubmissionEnabled:false,actions:Object.fromEntries(Object.keys(requirements).map(name=>[name,{provider:provider(name),...ready(name)}])),records:await summary(ctx)};
    },
    async generateVoice(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'voice');
      if (typeof getBriefing!=='function') fail('briefing_unavailable','An access-scoped saved briefing is required.',{status:503});
      const briefing=await getBriefing(principal,caseId);
      if (briefing.revision!==ctx.revision || typeof briefing.text!=='string') fail('stale_briefing','The briefing does not match this saved case.');
      const start=await begin(ctx,'voice',body,{text:briefing.text,voiceId:env.ELEVENLABS_VOICE_ID,model:env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'});
      if (!start.created) {
        const bytes=Buffer.from(start.record.result.audioBase64,'base64');
        if(!bytes.length || bytes.length>MAX_AUDIO_BYTES) fail('invalid_audio','The saved audio exceeds the supported playback limit.',{status:502});
        return {available:true,provider:'elevenlabs',contentType:'audio/mpeg',bytes,replayed:true};
      }
      try {
        await changed(principal,ctx);
        speech ||= createElevenLabs({env,maxAudioBytes:MAX_AUDIO_BYTES});
        const result=await speech.synthesise({text:briefing.text});
        const bytes=Buffer.from(result?.bytes || []);
        const id3=bytes.length>=10&&bytes.subarray(0,3).equals(Buffer.from('ID3'))&&[2,3,4].includes(bytes[3]);
        const mpeg=bytes.length>=4&&bytes[0]===255&&(bytes[1]&224)===224&&(bytes[1]&6)!==0&&(bytes[2]&240)!==240;
        if (!result?.available || result.contentType!=='audio/mpeg' || bytes.length>MAX_AUDIO_BYTES || (!id3&&!mpeg)) fail('invalid_audio','No valid ElevenLabs MP3 audio was received.',{status:502});
        await ledger.update(start.key,{state:'succeeded',result:{audioBase64:bytes.toString('base64'),byteLength:bytes.length,contentType:'audio/mpeg',provider:'elevenlabs',verified:true}});
        return {available:true,provider:'elevenlabs',contentType:'audio/mpeg',bytes,replayed:false};
      } catch(error) { return uncertain(start.key,error); }
    },
    async publishMiro(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'miro');
      if (typeof getBoard!=='function') fail('board_unavailable','An access-scoped saved board export is required.',{status:503});
      const board=await getBoard(principal,caseId);
      if (board.revision!==ctx.revision||board.caseId!==(ctx.packet.case.caseId||ctx.packet.case.id)||board.caseRecordId&&board.caseRecordId!==caseId) fail('stale_board','The board export does not match this saved case.');
      const boardId=env.MIRO_BOARD_ID.trim(), notes=planMiroNotes(board,{applicationOrigin:env.REFUND_OFFICE_PUBLIC_ORIGIN}),connectors=planMiroConnectors(board,notes);
      if (!notes.length || notes.length+connectors.length>100||notes.some(note=>note.body.data.content.length>10000)) fail('invalid_board','Use at most 100 bounded saved cards and connections.',{status:400});
      const counts={notes:notes.length,connectors:connectors.length};
      // Keep the original per-object ledger namespace so the existing hosted
      // schema can store both kinds without changing old migrations. itemKind
      // distinguishes connectors, and their local identity includes its kind.
      const expectedItemActions=[...notes,...connectors].map(item=>`miro-card-${item.localId}`);
      const planned={provider:'miro',boardId,verified:false,counts,expectedItemActions,expectedCardActions:notes.map(note=>`miro-card-${note.localId}`),phase:'prepared'};
      const start=await begin(ctx,'miro',body,{boardId,notes,connectors});
      if (!start.created) return {...start.record.result,replayed:true};
      const receipts=[];
      try {
        await ledger.update(start.key,{state:'acknowledged',result:planned});
        for (const note of notes) {
          await changed(principal,ctx);
          const card=await begin(ctx,`miro-card-${note.localId}`,body,{boardId,note},note.localId);
          if (!card.created) {receipts.push(card.record.result);continue;}
          let receipt=null;
          try {
            receipt={...await outbound.createMiroNote(boardId,note),itemKind:'note',localId:note.localId};
            if(receipts.some(item=>item.id===receipt.id))fail('board_duplicate_identity','Miro reused an object identity; the source map is incomplete.');
            await ledger.update(card.key,{state:'acknowledged',result:{...receipt,expectedContent:note.body.data.content}});
            const read=await outbound.getMiroNote(boardId,receipt.id);
            if (read.content!==note.body.data.content) fail('board_readback_mismatch','The saved Miro note content differs from the prepared card.');
            const verified={...receipt,verified:true,expectedContent:note.body.data.content};
            await ledger.update(card.key,{state:'succeeded',result:verified});receipts.push(verified);
          } catch(error) { await ledger.update(card.key,{state:'unknown',result:{...(receipt||{boardId,localId:note.localId,itemKind:'note',verified:false}),expectedContent:note.body.data.content},errorCode:errorCode(error)});throw error; }
        }
        for(const connector of connectors){
          await changed(principal,ctx);
          const prepared=resolveMiroConnector(connector,receipts);
          const saved=await begin(ctx,`miro-card-${connector.localId}`,body,{boardId,connector:prepared},connector.localId);
          if(!saved.created){receipts.push(saved.record.result);continue;}
          let receipt=null;
          try{
            receipt={...await outbound.createMiroConnector(boardId,prepared),localId:connector.localId,itemKind:'connector'};
            if(receipts.some(item=>item.id===receipt.id))fail('board_duplicate_identity','Miro reused an object identity; the source map is incomplete.');
            await ledger.update(saved.key,{state:'acknowledged',result:{...receipt,expectedConnector:prepared.body}});
            const read=await outbound.getMiroConnector(boardId,receipt.id);if(!connectorMatch(read,prepared.body))fail('board_readback_mismatch','The saved Miro connector endpoints or caption differ from the prepared relationship.');
            const verified={...receipt,verified:true,expectedConnector:prepared.body};await ledger.update(saved.key,{state:'succeeded',result:verified});receipts.push(verified);
          }catch(error){await ledger.update(saved.key,{state:'unknown',result:{...(receipt||{boardId,localId:connector.localId,itemKind:'connector',verified:false}),expectedConnector:prepared.body},errorCode:errorCode(error)});throw error;}
        }
        const result={provider:'miro',boardId,verified:true,counts,items:receipts.map(publicMiroReceipt),scope:'Every planned note and connector was independently read back. This does not approve or pay a refund.'};
        await ledger.update(start.key,{state:'succeeded',result});return result;
      } catch(error) {return uncertain(start.key,error,planned);}
    },
    async readMiro(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'miro');
      const records=await ledger.list(ctx), cards=records.filter(row=>row.action.startsWith('miro-card-'));
      for (const card of cards) {
        // A lost response without an item ID cannot be proved absent. Never repost.
        if (!card.result?.id || card.state==='succeeded') continue;
        if(card.result.itemKind==='connector'){
          const read=await outbound.getMiroConnector(card.result.boardId,card.result.id);if(!connectorMatch(read,card.result.expectedConnector))fail('board_readback_mismatch','The retrieved connector differs from its saved endpoints or caption.');
        }else{
          const read=await outbound.getMiroNote(card.result.boardId,card.result.id);
          if (read.content!==card.result.expectedContent) fail('board_readback_mismatch','The retrieved Miro card differs from the saved command.');
        }
        await ledger.update(card.key,{state:'succeeded',result:{...card.result,verified:true}});
      }
      const updated=await ledger.list(ctx), parent=updated.find(row=>row.action==='miro');
      const expected=parent?.result?.expectedItemActions||parent?.result?.expectedCardActions;
      if (parent?.state !== 'succeeded' && expected?.length && expected.every(action=>updated.some(row=>row.action===action && row.state==='succeeded' && row.result?.verified))) {
        const items=updated.filter(row=>expected.includes(row.action)).map(row=>publicMiroReceipt(row.result));
        if(new Set(items.map(item=>item.id)).size!==items.length)fail('board_duplicate_identity','The saved source map has repeated provider object identities.');
        await ledger.update(parent.key,{state:'succeeded',result:{provider:'miro',boardId:parent.result.boardId,verified:true,counts:parent.result.counts||{notes:items.length,connectors:0},items,scope:'All originally planned notes and connectors independently read back; no objects were reposted.'}});
      }
      return {provider:'miro',records:await summary(ctx),scope:'Readback only. Unknown notes or connectors without a provider identity remain blocked; no object was reposted.'};
    },
    async processEvidence(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'modal');
      const evidence=ctx.packet.case.evidence?.find(item=>item.id===body.evidenceId);
      if (!evidence || typeof evidence.body!=='string') fail('evidence_required','Select a saved evidence document from this case.',{status:400});
      const document={id:evidence.id,text:evidence.body};
      const start=await begin(ctx,'modal',body,document,evidence.id);
      if (!start.created) return {...start.record.result,replayed:true};
      try {
        await changed(principal,ctx);
        const result=await outbound.extractWithModal(document);
        if (result.authoritative!==false || result.documentId!==document.id) fail('extraction_mismatch','Modal did not return a non-authoritative result for this saved document.');
        const output={...result,caseId,revision:ctx.revision,scope:'Processing aid only. Saved evidence, case revision, recommendation and approval are unchanged.'};
        await ledger.update(start.key,{state:'succeeded',result:output});return output;
      } catch(error) {return uncertain(start.key,error);}
    },
    async publishPort(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'port');
      const start=await begin(ctx,'port',body,{...service,blueprint:env.PORT_BLUEPRINT_ID,origin:env.PORT_API_URL});
      if (!start.created) return {...start.record.result,replayed:true};
      try {
        await changed(principal,ctx);await outbound.upsertPortService(service);
        const result=await outbound.getPortService(service.identifier);
        if(!portMatch(result)) fail('catalog_readback_mismatch','The saved Port metadata differs from the prepared service entry.');
        const receipt={...result,verified:true,scope:'Service catalogue metadata only. No case contents, refund authority or deployment was published.'};
        await ledger.update(start.key,{state:'succeeded',result:receipt});return receipt;
      } catch(error) {return uncertain(start.key,error);}
    },
    async readPort(principal,caseId,body) {
      const ctx=await prepare(principal,caseId,body,'port');
      const row=(await ledger.list(ctx)).find(item=>item.action==='port');
      if(!row) fail('action_missing','No saved Port command exists for this case revision.');
      if(row.payloadHash!==hash({...service,blueprint:env.PORT_BLUEPRINT_ID,origin:env.PORT_API_URL})) fail('configuration_changed','The Port configuration differs from the saved command. Readback must use its original destination.');
      const result=await outbound.getPortService(service.identifier);
      if(!portMatch(result)) fail('catalog_readback_mismatch','The saved Port metadata differs from the prepared service entry.');
      if(row.state==='succeeded') return {...row.result,readbackRefreshed:true};
      const receipt={...result,verified:true,scope:'Metadata independently retrieved; this does not establish deployment or payment capability.'};
      await ledger.update(row.key,{state:'succeeded',result:receipt});return receipt;
    },
  };
}
