import { createProviders } from './providers.mjs';
import { inspectClaimLanguage } from './claim-language.mjs';
import { createClaudeInvestigator } from './claude-investigator.mjs';
const fail = () => { const error = new Error('The investigation proposal does not match the saved evidence. It requires review; no payment was authorised.'); error.code = 'invalid_investigation_proposal'; throw error; };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['amountMinor', 'lineId', 'issue', 'reason', 'evidenceIds', 'source'];
export function investigationIdentity(provider) {
  if (!provider || typeof provider.proposeCase !== 'function' || typeof provider.capabilities !== 'function') fail();
  const value = provider.capabilities();
  if (!['local', 'openai', 'anthropic'].includes(value?.analyser)) fail();
  if (value.analyser === 'local') return Object.freeze({ provider: 'local', model: 'local-rules-v2', mode: 'local-rules' });
  if (value.networkMode !== 'external-enabled' || typeof value.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(value.model) || !['controlled-test','provider-response'].includes(value.responseMode)) fail();
  return Object.freeze({ provider: value.analyser, model: value.model, mode: value.responseMode });
}
// No model output supplies its own provenance, authority, price or policy.
// The application binds identity from server configuration, then PostgreSQL
// independently repeats catalogue, evidence, policy and approval checks.
export function prepareInvestigationProposal(value, input, identity) {
  if (!isObject(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key)) || value.source !== identity.provider
      || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || ![null,'string'].includes(value.lineId === null ? null : typeof value.lineId)
      || !['item_missing','delivery_dispute','unknown'].includes(value.issue) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.reason)
      || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 20 || value.evidenceIds.some(id => typeof id !== 'string' || id.length > 200) || new Set(value.evidenceIds).size !== value.evidenceIds.length) fail();
  const known = new Set((input.evidence || []).map(item => item.id));
  if (value.evidenceIds.some(id => !known.has(id))) fail();
  if (value.issue !== 'item_missing' && (value.amountMinor !== 0 || value.lineId !== null)) fail();
  if (identity.provider !== 'local') {
    const interpretation = inspectClaimLanguage(input);
    if (value.issue === 'item_missing') {
      const line = input.order?.lines?.find(line => line.id === value.lineId);
      const omitted = (input.order?.lines || []).filter(item => Number.isSafeInteger(item.ordered) && Number.isSafeInteger(item.packed) && item.ordered > item.packed);
      if (omitted.length > 1 && (interpretation.referencedLineIds.length !== 1 || interpretation.referencedLineIds[0] !== value.lineId)) fail();
      if (!line || !Number.isSafeInteger(line.ordered) || !Number.isSafeInteger(line.packed) || !Number.isSafeInteger(line.unitAmountMinor) || line.packed < 0 || line.ordered <= line.packed || line.unitAmountMinor <= 0
          || !Number.isSafeInteger((line.ordered - line.packed) * line.unitAmountMinor) || value.amountMinor !== (line.ordered - line.packed) * line.unitAmountMinor
          || !value.evidenceIds.includes(`order:${input.order.id}`) || !value.evidenceIds.includes(`packing:${input.order.id}`) || interpretation.blocked || interpretation.deliveryDispute
          || interpretation.mentionedLineIds.some(id => id !== value.lineId)) fail();
      const clarifications = (input.evidence || []).filter(item => item.kind === 'customer-clarification');
      if (clarifications.some(item => item.lineId !== value.lineId || !value.evidenceIds.includes(item.id))) fail();
    }
    return { ...structuredClone(value), provenance: { ...identity } };
  }
  // Existing local rehearsals need no schema upgrade. Their saved provenance
  // remains source=local; never relabel historical local runs as model calls.
  return structuredClone(value);
}

// The investigation path never reads Stripe, speech or unselected model keys.
export function createInvestigationProviders({ env = {}, fetchImpl = globalThis.fetch, responseMode } = {}) {
  const selected = env.REFUND_OFFICE_NETWORK === 'enabled' ? (env.REFUND_OFFICE_ANALYSER || 'local') : 'local';
  if (selected === 'local') return createProviders({ env: {}, fetchImpl });
  if (!['openai','anthropic'].includes(selected)) fail();
  if (!String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(value => value.trim()).includes(selected)) { const error = new Error('The selected investigation analyser has not been explicitly enabled.'); error.code = 'analysis_disconnected'; throw error; }
  const config = { REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: selected };
  if (selected === 'openai') { config.OPENAI_API_KEY = env.OPENAI_API_KEY; config.OPENAI_MODEL = env.OPENAI_MODEL; }
  else {
    config.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY; config.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL;
    if (env.REFUND_OFFICE_ANTHROPIC_MODE === 'tools') {
      config.REFUND_OFFICE_ANTHROPIC_MODE = 'tools'; config.REFUND_OFFICE_ENABLED_INTEGRATIONS = 'anthropic';
      const identity = { provider: 'anthropic', model: config.ANTHROPIC_MODEL, mode: responseMode === 'controlled-test' ? 'controlled-test' : 'provider-response' };
      return createClaudeInvestigator({ env: config, fetchImpl, responseMode, validateRecommendation: (value, input) => prepareInvestigationProposal(value, input, identity) });
    }
  }
  return createProviders({ env: config, fetchImpl, responseMode });
}
export function hasValidProposalProvenance(value) {
  if (!isObject(value) || !['local','openai','anthropic'].includes(value.source)) return false;
  const p = value.provenance;
  if (value.source === 'local' && p === undefined) return true;
  return isObject(p) && Object.keys(p).length === 3 && p.provider === value.source && typeof p.model === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(p.model)
    && (value.source === 'local' ? p.mode === 'local-rules' && p.model === 'local-rules-v2' : ['controlled-test','provider-response'].includes(p.mode));
}
