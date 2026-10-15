// Explicitly gated outbound clients. Offline application paths never call providers.
// Enabling a client requires both an explicit network opt-in and its own name.
import { createHash } from 'node:crypto';

export class IntegrationError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message); this.name = 'IntegrationError'; this.code = code; this.uncertain = uncertain;
  }
}
const fail = (code, message) => { throw new IntegrationError(code, message); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const miroIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_=-]{1,160}$/.test(value);
const unconfirmed = (code, message) => { throw new IntegrationError(code, message, { uncertain: true }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceLines = text => {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function planMiroNotes(board,{applicationOrigin}={}) {
  if (board?.format !== 'refund-office-case-board' || !Array.isArray(board.columns)) fail('invalid_board', 'Use a saved Refund Office case-board export.');
  let origin=null;
  if(applicationOrigin){try{const u=new URL(applicationOrigin);if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname))throw Error();origin=u.origin;}catch{fail('invalid_application_origin','Use the configured public HTTPS application origin without credentials or a path.');}}
  return board.columns.flatMap((column, x) => (column.cards || []).map((card, y) => {
    if(typeof card.id!=='string'||typeof card.title!=='string'||typeof card.text!=='string'||!Array.isArray(card.links||[]))fail('invalid_board','Each saved card needs a bounded title and text.');
    const links=(card.links||[]).map(link=>{const base='/api/cases/'+encodeURIComponent(board.caseRecordId);if(!board.caseRecordId||![base,base+'/export',base+'/report',base+'/board-export'].includes(link.path))fail('invalid_board_link','Use an implemented app-relative case or report path.');return origin?`<p><a href="${escapeHtml(origin+link.path)}">${escapeHtml(link.label)}</a> (${board.linksRequireSession?'sign-in required; ':''}current saved revision)</p>`:`<p>${escapeHtml(link.label)}: ${escapeHtml(link.path)} (public app origin needed for a clickable link)</p>`;}).join('');
    const excerpt=card.text.length>1200?card.text.slice(0,1200)+'\n[Excerpt; complete text and references are in the prepared map and case export.]':card.text;
    return {
    localId: digest(`${board.caseId}:${board.revision}:${column.id}:${card.id}`).slice(0, 24),
    nodeId:card.id,
    body: { data: { content: `<p>${board.synthetic===true?'Synthetic demonstration · ':''}${escapeHtml(String(board.caseId).slice(0,160))} · saved revision ${board.revision}</p>${board.identityScope?`<p>${escapeHtml(board.identityScope)}</p>`:''}<p><strong>${escapeHtml(String(column.title).slice(0,200))}: ${escapeHtml(card.title.slice(0,200))}</strong></p>${card.state?`<p>Record state: ${escapeHtml(card.state)}</p>`:''}<p>${escapeHtml(excerpt)}</p>${card.refs?.length?`<p>Saved references: ${escapeHtml(card.refs.map(ref=>ref.type+': '+ref.id).join('; ').slice(0,800))}</p>`:''}${links}`,shape:'rectangle' }, position: { x: x * 700, y: y * 550 },geometry:{width:450} },
  };}));
}

export function planMiroConnectors(board,notes=planMiroNotes(board)){
  if(!board.provenance)return [];
  const {nodes,edges}=board.provenance;
  if(board.provenance.schemaVersion!==1||!Array.isArray(nodes)||!Array.isArray(edges)||nodes.length!==notes.length||new Set(nodes.map(n=>n.id)).size!==nodes.length||new Set(notes.map(n=>n.nodeId)).size!==notes.length||nodes.some(n=>!notes.some(note=>note.nodeId===n.id))||new Set(edges.map(e=>e.id)).size!==edges.length)fail('invalid_board','The saved source map must match every prepared card.');
  return edges.map(edge=>{const from=notes.find(note=>note.nodeId===edge.from),to=notes.find(note=>note.nodeId===edge.to);if(!from||!to||from===to||typeof edge.id!=='string'||typeof edge.label!=='string'||!edge.label.length||edge.label.length>300)fail('invalid_board','Every source-map connector needs two distinct saved nodes and a bounded label.');return {localId:digest(`connector:${board.caseId}:${board.revision}:${edge.id}`).slice(0,24),fromLocalId:from.localId,toLocalId:to.localId,captionContent:escapeHtml(edge.label)};});
}

export function resolveMiroConnector(connector,receipts){
  const from=receipts.find(item=>item.localId===connector.fromLocalId),to=receipts.find(item=>item.localId===connector.toLocalId);
  if(!from?.verified||!to?.verified||!miroIdentifier(from.id)||!miroIdentifier(to.id)||from.id===to.id)fail('unverified_board_endpoints','Both saved connector endpoints must be distinct and independently verified.');
  return {localId:connector.localId,body:{startItem:{id:from.id,snapTo:'auto'},endItem:{id:to.id,snapTo:'auto'},shape:'elbowed',captions:[{content:connector.captionContent}]}};
}

export function createSponsorClients({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const enabled = new Set(String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(x => x.trim()));
  const network = env.REFUND_OFFICE_NETWORK === 'enabled';
  function gate(name) {
    if (!network || !enabled.has(name)) fail('integration_disconnected', `${name} is disconnected. Local preparation does not enable external requests.`);
  }
  function config(name) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (!value || /[\r\n]/.test(value)) fail('configuration_required', 'This integration needs explicit server-side configuration.');
    return value;
  }
  function endpoint(name, { originOnly = false, domains, exactDomains = false } = {}) {
    let url;
    try { url = new URL(config(name)); } catch { fail('invalid_endpoint', 'Configure a valid HTTPS integration endpoint.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) ||
      (originOnly && url.pathname !== '/') || (domains && !domains.some(d => url.hostname === d || (!exactDomains && url.hostname.endsWith('.' + d))))) {
      fail('invalid_endpoint', 'Use the documented HTTPS integration endpoint without embedded credentials.');
    }
    return originOnly ? url.origin : url.href;
  }
  async function jsonRequest(name, url, { method = 'GET', headers = {}, body } = {}) {
    gate(name);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 1024 * 1024) fail('request_too_large', 'The integration payload exceeds the one-megabyte limit.');
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(encoded ? { body: encoded } : {}) });
    } catch { throw new IntegrationError('connection_unconfirmed', `${name} did not return a confirmed result. Do not replay a write until its status is checked.`, { uncertain: method !== 'GET' }); }
    if (!response.ok) throw new IntegrationError('provider_rejected', `${name} rejected the request (HTTP ${response.status}). No automatic retry was made.`, { uncertain: method !== 'GET' && response.status >= 500 });
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new IntegrationError('invalid_response', `${name} returned an unexpected response type.`, { uncertain: method !== 'GET' });
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (!reader) throw new IntegrationError('invalid_response', 'The integration returned no response body.', { uncertain: method !== 'GET' });
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new IntegrationError('response_too_large', 'The integration response exceeded its size limit.', { uncertain: method !== 'GET' }); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError('invalid_response', `${name} returned an unreadable response.`, { uncertain: method !== 'GET' });
    }
  }
  return {
    status() { return { networkMode: network ? 'external-enabled' : 'offline', enabled: ['n8n','supabase','miro','modal','port'].filter(x => network && enabled.has(x)) }; },
    async sendN8nIntake(input) {
      gate('n8n');
      if (typeof input?.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.eventId) || !identifier(input.orderId) || typeof input.complaint !== 'string' || input.complaint.trim().length < 8 || input.complaint.length > 4000) fail('invalid_intake', 'Provide a stable event identity, order and complaint.');
      const result = await jsonRequest('n8n', endpoint('N8N_INTAKE_WEBHOOK_URL'), { method: 'POST', headers: { 'X-Refund-Intake-Token': config('N8N_INTAKE_TOKEN') }, body: { eventId: input.eventId, orderId: input.orderId, complaint: input.complaint } });
      if (!result || typeof result !== 'object' || result.eventId !== input.eventId || result.accepted !== true) unconfirmed('invalid_acknowledgement', 'n8n did not acknowledge this intake event.');
      return { accepted: true, eventId: result.eventId, scope: 'Intake acknowledgement only; not an investigation or refund result.' };
    },
    async getSupabaseReviewer(accessToken) {
      gate('supabase');
      if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) fail('reviewer_required', 'A signed-in reviewer token is required.');
      const result = await jsonRequest('supabase', endpoint('SUPABASE_URL', { originOnly: true, domains: ['supabase.co'] }) + '/auth/v1/user', {
        headers: { apikey: config('SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${accessToken}` },
      });
      if (!identifier(result?.id)) fail('invalid_reviewer', 'Supabase did not return a reviewer identity.');
      return { id: result.id };
    },
    async archiveSupabasePacket(packet, accessToken) {
      gate('supabase');
      if (!identifier(packet?.case?.id) || !Number.isSafeInteger(packet.case.revision) || packet.case.revision < 0) fail('invalid_packet', 'Use a saved decision packet with its case identity and revision.');
      const user = await this.getSupabaseReviewer(accessToken);
      const result = await jsonRequest('supabase', endpoint('SUPABASE_URL', { originOnly: true, domains: ['supabase.co'] }) + '/rest/v1/rpc/archive_refund_decision', {
        method: 'POST', headers: { apikey: config('SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${accessToken}` },
        body: { p_case_id: packet.case.id, p_revision: packet.case.revision, p_packet: packet },
      });
      if (result?.case_id !== packet.case.id || result.revision !== packet.case.revision || result.owner_id !== user.id) unconfirmed('archive_mismatch', 'The archive response does not match this reviewer and case revision.');
      return result;
    },
    async createMiroNote(boardId, preparedNote) {
      gate('miro');
      if (!miroIdentifier(boardId) || !preparedNote?.body?.data?.content || preparedNote.body.data.content.length > 10000) fail('invalid_board_note', 'Provide a configured board and a bounded prepared note.');
      const result = await jsonRequest('miro', `https://api.miro.com/v2/boards/${encodeURIComponent(boardId)}/sticky_notes`, {
        method: 'POST', headers: { Authorization: `Bearer ${config('MIRO_ACCESS_TOKEN')}` }, body: preparedNote.body,
      });
      if (!miroIdentifier(result?.id)) unconfirmed('invalid_board_receipt', 'Miro did not return an item identity. Check the board before retrying.');
      return { localId: preparedNote.localId, id: result.id, boardId, verified: false, scope: 'Write acknowledgement only. Saved note content has not been independently retrieved.' };
    },
    async getMiroNote(boardId, itemId) {
      gate('miro');
      if (!miroIdentifier(boardId) || !miroIdentifier(itemId)) fail('invalid_board_note', 'Provide the saved board and item identities.');
      const result = await jsonRequest('miro', `https://api.miro.com/v2/boards/${encodeURIComponent(boardId)}/sticky_notes/${encodeURIComponent(itemId)}`, { headers: { Authorization: `Bearer ${config('MIRO_ACCESS_TOKEN')}` } });
      if (result?.id !== itemId || typeof result?.data?.content !== 'string') fail('board_readback_mismatch', 'Miro did not return the requested note and content.');
      return { id: result.id, boardId, content: result.data.content };
    },
    async createMiroConnector(boardId,preparedConnector){
      gate('miro');const body=preparedConnector?.body;
      if(!miroIdentifier(boardId)||!miroIdentifier(body?.startItem?.id)||!miroIdentifier(body?.endItem?.id)||body.startItem.id===body.endItem.id||body.shape!=='elbowed'||!Array.isArray(body.captions)||body.captions.length!==1||typeof body.captions[0].content!=='string'||body.captions[0].content.length>2000)fail('invalid_board_connector','Use two verified item identities and one prepared relationship caption.');
      const result=await jsonRequest('miro',`https://api.miro.com/v2/boards/${encodeURIComponent(boardId)}/connectors`,{method:'POST',headers:{Authorization:`Bearer ${config('MIRO_ACCESS_TOKEN')}`},body});
      if(!miroIdentifier(result?.id))unconfirmed('invalid_board_receipt','Miro did not return a connector identity. Do not repeat the write.');
      return {localId:preparedConnector.localId,id:result.id,boardId,itemKind:'connector',verified:false,scope:'Write acknowledgement only; connector endpoints and caption need independent readback.'};
    },
    async getMiroConnector(boardId,connectorId){
      gate('miro');if(!miroIdentifier(boardId)||!miroIdentifier(connectorId))fail('invalid_board_connector','Use saved board and connector identities.');
      const result=await jsonRequest('miro',`https://api.miro.com/v2/boards/${encodeURIComponent(boardId)}/connectors/${encodeURIComponent(connectorId)}`,{headers:{Authorization:`Bearer ${config('MIRO_ACCESS_TOKEN')}`}});
      if(result?.id!==connectorId||!miroIdentifier(result.startItem?.id)||!miroIdentifier(result.endItem?.id)||!Array.isArray(result.captions)||result.captions.some(c=>typeof c?.content!=='string'))fail('board_readback_mismatch','Miro did not return the saved connector endpoints and captions.');
      return {id:result.id,boardId,startItemId:result.startItem.id,endItemId:result.endItem.id,shape:result.shape,captions:result.captions.map(c=>c.content)};
    },
    async extractWithModal(document) {
      gate('modal');
      if (!identifier(document?.id) || typeof document.text !== 'string' || !document.text.trim() || Buffer.byteLength(document.text) > 200000) fail('invalid_document', 'Provide a document identity and up to 200 KB of text.');
      const expectedLines = sourceLines(document.text);
      if (expectedLines.length > 2000) fail('invalid_document', 'Provide up to 2,000 lines of text.');
      const result = await jsonRequest('modal', endpoint('MODAL_EVIDENCE_URL', { domains: ['modal.run'] }), {
        method: 'POST', headers: { Authorization: `Bearer ${config('MODAL_EVIDENCE_TOKEN')}` }, body: { id: document.id, text: document.text },
      });
      if (result?.documentId !== document.id || result.sha256 !== digest(document.text) || !Array.isArray(result.lines) || result.lines.length !== expectedLines.length || result.lines.some((x, index) => !x || x.line !== index + 1 || x.text !== expectedLines[index]) || result.authoritative !== false) unconfirmed('extraction_mismatch', 'The extraction result does not match the submitted document.');
      return result;
    },
    async getPortService(serviceId) {
      gate('port');
      if (!identifier(serviceId)) fail('invalid_catalog_entry', 'Provide the saved service identity.');
      const base = endpoint('PORT_API_URL', { originOnly: true, domains: ['api.port.io', 'api.us.port.io'], exactDomains: true });
      const blueprint = config('PORT_BLUEPRINT_ID');
      if (!identifier(blueprint)) fail('invalid_blueprint', 'The configured blueprint identity is invalid.');
      const result = await jsonRequest('port', `${base}/v1/blueprints/${encodeURIComponent(blueprint)}/entities/${encodeURIComponent(serviceId)}`, { headers: { Authorization: `Bearer ${config('PORT_ACCESS_TOKEN')}` } });
      if (result?.entity?.identifier !== serviceId || !result.entity.properties) fail('catalog_readback_mismatch', 'Port did not return the requested service metadata.');
      return { identifier: result.entity.identifier, title: result.entity.title, properties: result.entity.properties };
    },
    async upsertPortService(service) {
      gate('port');
      if (!identifier(service?.identifier) || typeof service.title !== 'string' || !['offline','prepared','configured-unverified'].includes(service.status)) fail('invalid_catalog_entry', 'Provide a service identity, title and truthful readiness state.');
      const base = endpoint('PORT_API_URL', { originOnly: true, domains: ['api.port.io', 'api.us.port.io'], exactDomains: true });
      const blueprint = config('PORT_BLUEPRINT_ID');
      if (!identifier(blueprint)) fail('invalid_blueprint', 'The configured blueprint identity is invalid.');
      const result = await jsonRequest('port', `${base}/v1/blueprints/${encodeURIComponent(blueprint)}/entities?upsert=true&merge=true`, {
        method: 'POST', headers: { Authorization: `Bearer ${config('PORT_ACCESS_TOKEN')}` },
        body: { identifier: service.identifier, title: service.title.slice(0, 200), properties: { readiness: service.status, humanApprovalRequired: true, liveVerified: false }, relations: {} },
      });
      if (result?.entity?.identifier !== service.identifier) unconfirmed('catalog_mismatch', 'Port did not confirm the requested service identity.');
      return { identifier: result.entity.identifier, verified: false, scope: 'Catalog acknowledgement only; no deployment or refund permission. Saved metadata has not been independently retrieved.' };
    },
  };
}
