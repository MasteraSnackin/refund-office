import { createHash } from 'node:crypto';
import { inspectClaimLanguage } from './claim-language.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const line = value => object(value) && id(value.id) && text(value.name, 200) && integer(value.ordered) && value.ordered > 0 && value.ordered <= 100 && integer(value.packed) && value.packed <= value.ordered && integer(value.unitAmountMinor);
const sameLine = (a, b) => ['id', 'name', 'ordered', 'packed', 'unitAmountMinor'].every(key => a[key] === b[key]);
const parsed = entry => { try { return JSON.parse(entry.body); } catch { return null; } };
const list = names => names.length === 1 ? names[0] : names.length === 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;

// This is a read-only local writing aid, not a customer message or a financial
// decision. Only verified saved catalogue records enter the template. Original
// complaints, review notes, actor identities and source URLs are never copied.
export function buildCustomerClarificationDraft(packet) {
  const item = packet?.case;
  if (!object(item) || !id(item.id) || !id(item.caseId) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw Object.assign(new Error('The saved case identity could not be verified.'), { code: 'invalid_runtime_input' });
  const sourceBinding = { caseId: item.id, revision: item.revision };
  if (typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint)) sourceBinding.fingerprint = item.fingerprint;
  if (typeof item.fingerprintScheme === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item.fingerprintScheme)) sourceBinding.fingerprintScheme = item.fingerprintScheme;
  const result = { schemaVersion: 1, id: item.id, caseId: item.caseId, revision: item.revision, unsent: true, eligible: false, reason: '', draftText: '', evidenceRefs: [], sourceBinding };
  const blocked = reason => ({ ...result, reason });
  if (item.approval != null || item.receipt != null || item.operationId != null || ['approved-not-submitted', 'already-resolved', 'closed-no-refund'].includes(item.outcome) || ['reserved', 'closed', 'complete', 'archived'].includes(item.status) || ['closed', 'closed-no-refund'].includes(item.review?.state)) return blocked('This case already has an approval, reservation or final outcome. A clarification draft is not appropriate.');
  if (!['paused', 'review'].includes(item.status) || item.stage !== 'review' || item.intakeStatus === 'error' || item.outcome !== 'held') return blocked('A customer clarification draft is available only for a held investigation at Review.');
  if (!object(item.proposal) || item.proposal.issue !== 'unknown' && item.review?.state !== 'awaiting-evidence') return blocked('The saved hold does not identify an unresolved item question. Review the policy or evidence issue first.');
  if (!id(item.orderId) || !Array.isArray(item.evidence) || item.evidence.length > 100) return blocked('The saved order and evidence could not be verified.');
  const entries = new Map();
  for (const entry of item.evidence) {
    if (!object(entry) || !text(entry.id, 250) || entries.has(entry.id) || typeof entry.body !== 'string' || Buffer.byteLength(entry.body, 'utf8') > 262144) return blocked('The saved evidence contains a missing, repeated or unreadable record. Review the sources before drafting a reply.');
    entries.set(entry.id, entry);
  }
  const required = ['order', 'packing', 'delivery', 'remedies'].map(kind => entries.get(`${kind}:${item.orderId}`));
  if (required.some((entry, index) => !entry || entry.source !== (index === 3 ? 'Operational database' : 'Synthetic catalogue'))) return blocked('A matching saved order, packing, delivery and remedy record is required before drafting a reply.');
  const [order, packing, delivery, remedies] = required.map(parsed), current = packet.order;
  if (!object(order) || order.id !== item.orderId || order.synthetic !== true || order.currency !== 'gbp' || !integer(order.totalMinor) || !Array.isArray(order.lines) || !order.lines.length || order.lines.length > 50 || !order.lines.every(line) || new Set(order.lines.map(value => value.id)).size !== order.lines.length || new Set(order.lines.map(value => value.name.trim().toLowerCase())).size !== order.lines.length) return blocked('The saved order items are incomplete or ambiguous. Review the catalogue before drafting a reply.');
  if (!Array.isArray(packing) || packing.length !== order.lines.length || !packing.every(line) || new Set(packing.map(value => value.id)).size !== packing.length || !order.lines.every(value => packing.some(saved => sameLine(value, saved)))) return blocked('The saved packing record does not agree with the order items. Review the conflicting evidence first.');
  if (!object(current) || current.id !== order.id || current.synthetic !== order.synthetic || current.currency !== order.currency || current.totalMinor !== order.totalMinor || !Array.isArray(current.lines) || current.lines.length !== order.lines.length || !order.lines.every(value => current.lines.some(saved => object(saved) && sameLine(value, saved)))) return blocked('The current order differs from the saved investigation. Investigate the updated records before drafting a reply.');
  if (!object(delivery) || !text(delivery.status, 100) || typeof delivery.disputed !== 'boolean' || !text(delivery.detail, 2000) || !object(order.delivery) || delivery.status !== order.delivery.status || delivery.disputed !== order.delivery.disputed || delivery.detail !== order.delivery.detail || !object(current.delivery) || delivery.status !== current.delivery.status || delivery.disputed !== current.delivery.disputed || delivery.detail !== current.delivery.detail) return blocked('The saved delivery record could not be matched to this investigation. Review it before drafting a reply.');
  if (delivery.disputed) return blocked('This case includes a delivery dispute. Review that issue before asking the customer to identify missing items.');
  if (!Array.isArray(remedies) || remedies.length) return blocked('The remedy history is missing or already contains an earlier remedy or reservation. Review that history before drafting a reply.');
  if (!Array.isArray(item.checks) || item.checks.some(check => !object(check) || !text(check.id, 100) || typeof check.pass !== 'boolean')) return blocked('The saved policy checks could not be verified. Review the investigation before drafting a reply.');
  if (item.checks.some(check => ['duplicate', 'delivery', 'balance', 'limit'].includes(check.id) && check.pass === false)) return blocked('A separate policy, delivery or remedy check is on hold. Resolve that hold before drafting an item clarification.');
  const clarification = item.evidence.filter(entry => entry.kind === 'customer-clarification');
  if (clarification.some(entry => !/^clarification:[a-f0-9-]{36}$/i.test(entry.id) || entry.source !== 'Customer clarification recorded by reviewer' || !order.lines.some(value => value.id === entry.lineId) || !text(entry.body, 4000))) return blocked('An earlier clarification could not be verified. Review the saved statements before drafting a reply.');
  if (clarification.some(entry => { const claim = inspectClaimLanguage({ complaint: entry.body, order }); return claim.blocked || claim.deliveryDispute || claim.mentionedLineIds.length !== 1 || claim.mentionedLineIds[0] !== entry.lineId; })) return blocked('An earlier clarification disagrees with its selected item. Review the conflicting statements before drafting a reply.');
  if (typeof item.complaint !== 'string' || !item.complaint.trim() || item.complaint.length > 4000) return blocked('The original customer request could not be verified.');
  const interpretation = inspectClaimLanguage({ complaint: item.complaint, order, evidence: item.evidence });
  if (interpretation.deliveryDispute || interpretation.blocked) return blocked('The saved statements contain a delivery dispute, contradiction or uncertain claim. A reviewer should decide the next question.');
  if (!interpretation.genericMissing && !interpretation.mentionedLineIds.length) return blocked('The saved request does not establish a missing-item question that this local template can safely draft.');
  const missing = order.lines.filter(value => value.ordered > value.packed);
  if (!missing.length || interpretation.mentionedLineIds.some(lineId => !missing.some(value => value.id === lineId))) return blocked('The stated missing item does not agree with the packing record. Review the conflicting sources before drafting a reply.');
  if (missing.length > 10) return blocked('This order needs a broader item review than the local clarification template supports.');
  const used = [...required, ...clarification];
  result.evidenceRefs = used.map(entry => entry.id);
  result.sourceBinding = { ...sourceBinding, orderId: order.id, evidenceDigest: createHash('sha256').update(JSON.stringify(used.map(entry => ({ id: entry.id, source: entry.source, body: entry.body, ...(entry.kind ? { kind: entry.kind, lineId: entry.lineId } : {}) })))).digest('hex') };
  const names = missing.map(value => `“${value.name}”`);
  return { ...result, eligible: true, reason: 'Prepared from the current held investigation. Review and edit this draft before using it; no message has been sent.',
    draftText: `Hello,\n\nThanks for letting us know about order ${order.id}. Could you confirm which item or items did not arrive: ${list(names)}? Please tell us the missing quantity for each item.\n\nThis will help us review your request.\n\nThank you.` };
}
