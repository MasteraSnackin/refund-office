const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const readable = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export function canInspectCustomerDraft(scenario, capabilities) {
  return capabilities?.customerDrafts === true && scenario?.status === 'review' && scenario.outcome === 'held'
    && !scenario.approval && !scenario.operationId && !scenario.receipt;
}

export function verifyCustomerDraft(value, scenario) {
  const binding = value?.sourceBinding;
  if (!value || value.schemaVersion !== 1 || value.unsent !== true || typeof value.eligible !== 'boolean'
    || !identifier(value.id) || value.id !== scenario.id || value.caseId !== scenario.caseId
    || value.revision !== scenario.revision || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !binding || binding.caseId !== scenario.id || binding.revision !== scenario.revision
    || !readable(value.reason, 2000) || !Array.isArray(value.evidenceRefs)
    || value.evidenceRefs.length > 100 || new Set(value.evidenceRefs).size !== value.evidenceRefs.length
    || value.evidenceRefs.some(id => typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,250}$/.test(id))) {
    throw new Error('The question could not be matched to this saved case. Refresh the office before preparing another draft.');
  }
  if (value.eligible && (!readable(value.draftText, 12000) || binding.orderId !== scenario.orderId || !digest(binding.evidenceDigest))) {
    throw new Error('The draft or its saved evidence could not be verified. No text was copied or downloaded.');
  }
  if (!value.eligible && value.draftText !== '') throw new Error('An unavailable draft must not contain customer wording.');
  if (binding.fingerprint !== undefined && (!digest(binding.fingerprint) || binding.fingerprint !== scenario.fingerprint)) {
    throw new Error('The draft belongs to different investigation facts. Refresh the office first.');
  }
  const known = new Set((scenario.evidence || []).map(entry => entry.id));
  if (value.eligible && (!value.evidenceRefs.length || value.evidenceRefs.some(id => !known.has(id)))) {
    throw new Error('The draft cites evidence outside this saved case. No text was copied or downloaded.');
  }
  return value;
}

export function sameCustomerDraft(left, right) {
  return left?.eligible === true && right?.eligible === true && left.id === right.id && left.revision === right.revision
    && left.draftText === right.draftText && left.sourceBinding?.evidenceDigest === right.sourceBinding?.evidenceDigest
    && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs);
}

export function customerDraftFile(value) {
  return { filename: value.caseId.replace(/[^A-Za-z0-9_-]/g, '') + '-unsent-question.txt',
    text: `UNSENT CUSTOMER DRAFT\nCase: ${value.caseId}\nSaved revision: ${value.revision}\n\n${value.draftText}\n\nInternal source references: ${value.evidenceRefs.join(', ')}\nThis application has not sent this message. A received answer must be recorded separately.\n` };
}
