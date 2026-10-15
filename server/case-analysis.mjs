import { createHash } from 'node:crypto';
import { createProviders } from './providers.mjs';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

// An inspectable second opinion. It has no repository write or payment interface.
// The ordinary investigator continues to save its deterministic local proposal.
export function createCaseAnalysis({ env = {}, fetchImpl = globalThis.fetch, getPacket } = {}) {
  if (typeof getPacket !== 'function') throw new TypeError('An access-scoped saved packet reader is required.');
  const network = env.REFUND_OFFICE_NETWORK === 'enabled';
  const enabled = new Set(network ? String(env.REFUND_OFFICE_ENABLED_INTEGRATIONS || '').split(',').map(value => value.trim()) : []);
  const primaryName = network ? String(env.REFUND_OFFICE_ANALYSER || 'local') : 'local';
  const challengeName = network ? String(env.REFUND_OFFICE_CHALLENGER || 'none') : 'none';
  if (!['local', 'openai', 'anthropic'].includes(primaryName) || !['none', 'anthropic'].includes(challengeName)) fail(503, 'analysis_configuration', 'Choose a supported primary analyser and optional Anthropic second opinion.');
  if (challengeName === primaryName) fail(503, 'analysis_configuration', 'A second opinion requires a different primary analyser.');
  for (const name of [primaryName, challengeName]) if (!['none', 'local'].includes(name) && !enabled.has(name)) fail(503, 'analysis_disconnected', 'The selected analyser has not been explicitly enabled.');
  const provider = name => createProviders({ env: name === 'local' ? {} : {
    REFUND_OFFICE_NETWORK: 'enabled', REFUND_OFFICE_ANALYSER: name,
    ...(name === 'openai' ? { OPENAI_API_KEY: env.OPENAI_API_KEY, OPENAI_MODEL: env.OPENAI_MODEL }
      : { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: env.ANTHROPIC_MODEL }),
  }, fetchImpl });
  const primary = provider(primaryName), challenger = challengeName === 'none' ? null : provider(challengeName);
  const status = () => ({ primary: primaryName, challenger: challengeName, mode: network ? 'configured-unverified' : 'local-rules', advisoryOnly: true, changesSavedCase: false, humanApprovalRequired: true });

  async function saved(principal, caseId, revision) {
    if (!principal || !uuid(principal.userId) || !uuid(principal.tenantId) || !['reviewer', 'investigator'].includes(principal.role)) fail(403, 'analysis_access_denied', 'A reviewer or investigator session is required.');
    if (!id(caseId) || !Number.isSafeInteger(revision) || revision < 1) fail(400, 'invalid_analysis_input', 'Use the exact saved case revision.');
    const packet = await getPacket(principal, caseId);
    if (packet?.tenantId !== principal.tenantId || packet.case?.id !== caseId || packet.order?.id !== packet.case?.orderId) fail(403, 'analysis_access_denied', 'The saved case is not available in this workspace.');
    if (packet.case.revision !== revision) fail(409, 'analysis_stale_case', 'The case changed. Refresh before requesting another opinion.');
    if (!Array.isArray(packet.case.evidence) || !packet.case.evidence.length || !Array.isArray(packet.order.lines) || !packet.order.lines.length) fail(409, 'analysis_evidence_required', 'Investigate the case before requesting a second opinion.');
    // Only saved inputs cross the provider boundary. A caller cannot substitute
    // an amount, complaint, evidence, tenant or reviewer identity in the body.
    const input = structuredClone({ complaint: packet.case.complaint, order: packet.order, evidence: packet.case.evidence.map(({ id, title, body, source, kind, lineId, sourceReference, actor, at, expectedRevision }) => ({ id, title, body, source, ...(kind==='customer-clarification'?{kind,lineId,sourceReference,actor,at,expectedRevision}:{}) })) });
    if (JSON.stringify(input).length > 200000) fail(413, 'analysis_input_too_large', 'The saved evidence is too large for this briefing action.');
    return { input, fingerprint: digest(input) };
  }
  function inspect(proposal, input) {
    const supplied = new Set(input.evidence.map(entry => entry.id));
    const line = input.order.lines.find(entry => entry.id === proposal.lineId);
    const referencesKnown = proposal.evidenceIds.every(value => supplied.has(value));
    const exactMissingValue = proposal.issue !== 'item_missing' ? proposal.amountMinor === 0 && proposal.lineId === null
      : Boolean(line && Number.isSafeInteger(line.ordered) && Number.isSafeInteger(line.packed) && line.ordered > line.packed
        && Number.isSafeInteger(line.unitAmountMinor) && proposal.amountMinor === (line.ordered - line.packed) * line.unitAmountMinor
        && proposal.evidenceIds.includes(`packing:${input.order.id}`));
    return { proposal, checks: { referencesKnown, exactMissingValue }, supportedBySnapshot: referencesKnown && exactMissingValue };
  }
  return { status, async run(principal, caseId, body) {
    if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'expectedRevision')) fail(400, 'invalid_analysis_input', 'This action accepts only the saved case revision.');
    const before = await saved(principal, caseId, body.expectedRevision);
    const events = [];
    async function ask(client, name) {
      try {
        const result = inspect(await client.proposeCase(structuredClone(before.input)), before.input);
        events.push({ actor: name, event: 'proposal-returned', supportedBySnapshot: result.supportedBySnapshot });
        return result;
      } catch (error) {
        // Never copy remote error bodies or silently substitute a different model.
        events.push({ actor: name, event: 'proposal-unavailable' });
        return { unavailable: true, code: /^[a-z][a-z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'analysis_unavailable' };
      }
    }
    const first = await ask(primary, primaryName);
    // The challenger sees the same evidence independently, not another model's
    // rationale. Compare conclusions after both calls have actually returned.
    const second = challenger ? await ask(challenger, challengeName) : null;
    const after = await saved(principal, caseId, body.expectedRevision);
    if (before.fingerprint !== after.fingerprint) fail(409, 'analysis_stale_case', 'The evidence changed while the analysis ran. Refresh the saved record.');
    const comparison = !second ? 'not-requested' : first.unavailable || second.unavailable ? 'incomplete'
      : ['amountMinor', 'lineId', 'issue'].every(key => first.proposal[key] === second.proposal[key]) ? 'agreement' : 'disagreement';
    return { ...status(), caseId, revision: body.expectedRevision, evidenceDigest: before.fingerprint,
      primary: first, challenger: second, comparison, needsHumanReview: true, events,
      explanation: 'This advisory result does not change the saved proposal, policy checks, approval or payment state. Agreement between models is not payment authorisation.' };
  } };
}
