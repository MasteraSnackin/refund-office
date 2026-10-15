import { HostedError, hostedPublicSettings, requireHostedEnabled } from './hosted-auth.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const states = ['pending','acknowledged','succeeded','unknown','rejected'];
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key,sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(JSON.parse(JSON.stringify(value))));
function unresolved() { throw Object.assign(new HostedError(503, 'sponsor_journal_unverified', 'The durable action state could not be confirmed. Do not repeat the provider write.'), { uncertain: true }); }
const invalid = () => { throw new HostedError(400, 'sponsor_journal_input', 'Use the exact saved case, action and command identities.'); };
export function createSupabaseSponsorLedger({ env = process.env, tenantId, getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  function settings() {
    requireHostedEnabled(env); const config = hostedPublicSettings(env);
    if (config.tenantId !== tenantId) invalid();
    let origin; try { origin = new URL(env.SUPABASE_URL); if (origin.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(origin.hostname) || origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error(); } catch { throw new HostedError(503, 'sponsor_journal_configuration', 'Configure the intended Supabase project.'); }
    const key = env.SUPABASE_PUBLISHABLE_KEY;
    if (typeof key !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || key.length > 8192 || typeof getAccessToken !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new HostedError(503, 'sponsor_journal_configuration', 'Configure a publishable key and bounded user-session transport.');
    return { origin, key };
  }
  function verified(value) {
    if (!object(value) || value.tenantId !== tenantId || !HASH.test(value.key || '') || !HASH.test(value.payloadHash || '') || !UUID.test(value.commandId || '') || typeof value.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.caseId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !states.includes(value.state) || !/^(voice|miro|modal|port|miro-card-[a-f0-9]{24})$/.test(value.action || '')) unresolved();
    return value;
  }
  async function rpc(action, input, write = false) {
    const config = settings(); const token = await getAccessToken(); let claims;
    try { if (typeof token !== 'string' || token.length > 12000 || /\s/.test(token) || token.split('.').length !== 3) throw new Error(); claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { throw new HostedError(401, 'hosted_session_required', 'A current user session is required.'); }
    if (!object(claims) || claims.role !== 'authenticated' || claims.is_anonymous === true || !UUID.test(claims.sub || '') || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now()/1000) throw new HostedError(401, 'hosted_session_required', 'A current non-anonymous user session is required.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL('/rest/v1/rpc/refund_runtime_sponsor_action', config.origin), { method:'POST', redirect:'error', signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json',apikey:config.key,Authorization:`Bearer ${token}`}, body:JSON.stringify({p_tenant_id:tenantId,p_action:action,p_input:input}) });
      if (Number(response.headers.get('content-length')) > 16*1024*1024) unresolved();
      const reader=response.body?.getReader(); if(!reader) unresolved(); const chunks=[]; let size=0;
      try {
        for(;;) { const next=await reader.read(); if(next.done) break; size+=next.value.byteLength; if(size>16*1024*1024){await reader.cancel();unresolved();} chunks.push(Buffer.from(next.value)); }
        const value=JSON.parse(Buffer.concat(chunks));
        if(!response.ok) {
          if([401,403].includes(response.status)||object(value)&&['22023','28000','42501','40001','23505','23503','23514','55000'].includes(value.code)) throw new HostedError([401,403].includes(response.status)?response.status:409,'sponsor_journal_rejected','The user, saved revision or action state was rejected.');
          unresolved();
        }
        return value;
      }
      finally { reader.releaseLock(); }
    } catch(error) { if(error instanceof HostedError) throw error; if(write) unresolved(); throw new HostedError(502,'sponsor_journal_unavailable','The saved sponsor action journal is unavailable.'); }
    finally { clearTimeout(timer); }
  }
  async function get(key) { requireHostedEnabled(env); if(!HASH.test(key || '')) invalid(); const value=await rpc('get',{key}); if(value===null)return null; const result=verified(value); if(result.key!==key) unresolved(); return result; }
  return {
    durable: true,
    get,
    async begin(input) {
      requireHostedEnabled(env);
      if(!object(input)||input.tenantId!==tenantId) invalid(); verified({...input,state:'pending'});
      const {key,caseId,revision,action,commandId,payloadHash}=input;
      const result=await rpc('begin',{key,caseId,revision,action,commandId,payloadHash},true);
      if(!object(result)||typeof result.created!=='boolean') unresolved(); const ack=verified(result.record);
      // Existing command conflicts intentionally return their original record;
      // the facade compares its key/hash and never posts a changed payload.
      if(result.created&&(ack.key!==key||ack.caseId!==caseId||ack.revision!==revision||ack.action!==action||ack.commandId!==commandId||ack.payloadHash!==payloadHash||ack.state!=='pending')) unresolved();
      const saved=await get(ack.key).catch(()=>unresolved());
      if(!saved||['key','caseId','revision','action','commandId','payloadHash'].some(field=>saved[field]!==ack[field])||result.created&&saved.state!=='pending') unresolved();
      return {created:result.created,record:saved};
    },
    async update(key,{state,result=null,errorCode=null}={}) {
      requireHostedEnabled(env);
      if(!HASH.test(key || '')||!states.includes(state)||state==='pending'||result!==null&&!object(result)||errorCode!==null&&!/^[a-z][a-z0-9_]{0,79}$/.test(errorCode)) invalid();
      let encoded;try{encoded=JSON.stringify(result);}catch{invalid();}if(Buffer.byteLength(encoded)>12*1024*1024)invalid();
      const ack=verified(await rpc('update',{key,state,result,errorCode},true));
      if(ack.key!==key||ack.state!==state||ack.errorCode!==errorCode||!(state==='unknown'&&result===null)&&canonical(ack.result)!==canonical(result))unresolved();
      const saved=await get(key).catch(()=>unresolved());
      if(!saved||saved.state!==state||canonical(saved.result)!==canonical(ack.result)||saved.errorCode!==ack.errorCode||['caseId','revision','action','commandId','payloadHash'].some(field=>saved[field]!==ack[field]))unresolved();
      return saved;
    },
    async list({tenantId:requestedTenant,caseId,revision}={}) {
      requireHostedEnabled(env);
      if(requestedTenant!==tenantId||typeof caseId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(caseId)||!Number.isSafeInteger(revision)||revision<1) invalid();
      const rows=await rpc('list',{caseId,revision}); if(!Array.isArray(rows)||rows.length>200)unresolved();
      return rows.map(row=>{const saved=verified(row);if(saved.caseId!==caseId||saved.revision!==revision)unresolved();return saved;});
    },
  };
}
