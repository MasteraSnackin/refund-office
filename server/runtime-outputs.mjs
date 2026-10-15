// Presentation only: these functions consume saved records. They do not infer
// approval from an event, change evidence, or inspect a payment provider.
const plain = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const text = (value, fallback = 'Not recorded') => plain(value) || fallback;
const markdown = value => text(value, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`~*_{}\[\]()#+.!|])/g, '\\$1');
const money = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100) : 'Amount not recorded';
const list = value => Array.isArray(value) ? value : [];
const reviewEvents = item => list(item.events).filter(event => typeof event?.type === 'string' && event.type.startsWith('review.'));
const identityLines = decision => [`Recorded actor: ${text(decision.actor)}`, `Recorded at: ${text(decision.decidedAt || decision.at)}`, `Reason: ${text(decision.note)}`];

export function runtimeDecisionLines(item) {
  const approval = item.approval, review = item.review, lines = [];
  if (approval?.state === 'approved') lines.push(`Current refund approval: recorded for ${money(approval.amountMinor)}.`, ...identityLines(approval));
  else if (approval?.state === 'invalidated') lines.push('Current refund approval: invalidated. A fresh human decision is required.', `Reason: ${text(approval.reason)}`);
  else if (approval?.state === 'required' || item.outcome === 'awaiting-approval') lines.push(`Current refund approval: required for ${money(approval?.amountMinor ?? item.proposedAmountMinor)} and has not been granted.`);
  else lines.push('No current refund approval is recorded.');
  if (plain(review?.state)) {
    const states = { 'awaiting-evidence': 'Evidence requested; no customer message was sent', closed: 'Closed without refund', reopened: 'Reopened for investigation; this is not refund approval' };
    lines.push(`Current review: ${states[review.state] || text(review.state)}.`, ...identityLines(review));
  } else lines.push('No current review decision is attached to this case state.');
  const earlier = reviewEvents(item);
  if (earlier.length) lines.push(`Saved review history contains ${earlier.length} ${earlier.length === 1 ? 'event' : 'events'}. Those records are preserved below and do not grant current refund approval.`);
  lines.push(`Original operation: ${text(item.operationId, 'None recorded')}`);
  return lines;
}

export function buildRuntimeBriefing(item, { hosted = false, paymentText } = {}) {
  const sections = [
    { heading: 'Saved case', text: `${text(item.caseId)}: ${text(item.title)}. ${text(item.summary)}` },
    { heading: 'Investigation', text: text(item.proposal?.reason, 'Investigation has not completed.') },
    { heading: 'Human review', text: runtimeDecisionLines(item).join('\n').replace('Those records are preserved below', 'Those records remain in the saved case history') },
    { heading: hosted ? 'Payment scope' : 'Payment boundary', text: paymentText },
  ];
  return { caseId: item.caseId, revision: item.revision, title: `Briefing: ${text(item.title)}`, mode: 'local-text', text: sections.map(section => `${section.heading}\n${section.text}`).join('\n\n'), sections,
    audio: { available: false, provider: 'elevenlabs', reason: hosted ? 'Use the explicitly configured voice action to request new audio.' : 'External voice services are disconnected.' } };
}

// JSON escapes preserve the exact original string on parsing, while preventing
// supplied Markdown/HTML or fence delimiters from becoming active document text.
function exactEvidenceJson(evidence) {
  return JSON.stringify(evidence.map(entry => ({ ...(Object.hasOwn(entry, 'id') ? { id: entry.id } : {}), ...(Object.hasOwn(entry, 'body') ? { body: entry.body } : {}) })), null, 2)
    .replace(/[<>&!()`]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function buildRuntimeDecisionReport(item, { hosted = false, paymentText, connectionText } = {}) {
  const evidence = list(item.evidence), checks = list(item.checks), events = list(item.events);
  const citations = [...new Set(list(item.proposal?.evidenceIds).filter(id => typeof id === 'string'))];
  const gatheredIds = new Set(evidence.map(entry => entry.id).filter(id => typeof id === 'string'));
  const unresolved = citations.filter(id => !gatheredIds.has(id));
  const readableEvidence = evidence.flatMap(entry => [
    `### ${markdown(text(entry.title, 'Saved evidence'))}`, '',
    `Evidence reference: ${markdown(text(entry.id))}`,
    `Use in this saved proposal: ${typeof entry.id === 'string' && citations.includes(entry.id) ? 'Cited by the saved proposal.' : 'Gathered record; not cited by the saved proposal.'}`,
    `Source: ${markdown(text(entry.source))}`, '',
    markdown(text(entry.displayBody, text(entry.body, 'No readable text body is recorded.'))),
    ...(entry.kind === 'customer-clarification' ? ['', `Selected order line: ${markdown(text(entry.lineId))}`, `Source reference: ${markdown(text(entry.sourceReference))}`, `Recorded by: ${markdown(text(entry.actor))}`, `Recorded at: ${markdown(text(entry.at))}`] : []), '',
  ]);
  const header = hosted ? 'Hosted Supabase workspace · synthetic records · original case reservation' : 'Local PostgreSQL rehearsal · synthetic records · payment submission disabled';
  const payment = hosted ? [paymentText, 'This report does not retrieve separate execution records. It makes no claim about whether such a record has a provider response or verified refund.', ...(item.receipt?.seeded ? ['An explicitly seeded historical receipt is attached to the original case. It is demonstration history.'] : [])]
    : [item.outcome === 'approved-not-submitted' ? '**Reserved only. Not submitted and not paid.**' : item.receipt?.seeded ? 'An explicitly seeded historical fixture was linked. No new payment was made.' : 'No payment was submitted or made.'];
  const result = [
    `# ${markdown(text(item.caseId))} — ${markdown(text(item.title))}`, '', header, '',
    `Saved revision: ${item.revision}`, `${hosted ? 'Original case outcome' : 'Outcome'}: ${markdown(text(item.outcome, 'Investigation pending'))}`, `Proposed amount: ${money(item.proposedAmountMinor)}`, '', markdown(text(item.summary)), '',
    '## Complaint', '', markdown(text(item.complaint)), '', '## Investigation', '', markdown(text(item.proposal?.reason, 'Not completed.')), '',
    `Evidence references cited by the saved proposal: ${citations.length ? citations.map(markdown).join(', ') : 'None recorded'}.`,
    ...(unresolved.length ? [`Unresolved cited references: ${unresolved.map(markdown).join(', ')}. No matching gathered record is included.`] : []), '',
    '## Saved policy checks', '', 'These are saved investigation checks, not current payment results.', '',
    ...(checks.length ? checks.map(check => `- ${markdown(text(check.label, 'Saved check'))} [${markdown(text(check.id))}]: ${markdown(text(check.status, 'Result not recorded'))}. ${markdown(text(check.detail, 'No explanation was saved.'))}`) : ['No policy checks are saved.']), '',
    '## Human decision', '', ...runtimeDecisionLines(item).map(markdown), '',
    hosted ? '## Payment scope' : '## Payment result', '', ...payment, '',
    '## Saved evidence', '', 'The readable descriptions below come from the saved evidence snapshot. Citation labels refer only to the current saved proposal, not earlier investigation events.', '',
    ...(readableEvidence.length ? readableEvidence : ['No evidence records are saved.', '']),
    '## Recorded history', '', 'History is shown in saved append order. Earlier review events do not grant current refund approval.', '',
    ...(events.length ? events.map(event => `- ${markdown(text(event.at, 'Time not recorded'))} — ${markdown(text(event.label, 'Saved event'))}: ${markdown(text(event.detail, 'No detail recorded'))} Event reference: ${markdown(text(event.id == null ? undefined : String(event.id)))}. Recorded actor: ${markdown(text(event.actor))}.`) : ['No history events are saved.']), '',
    '## Exact saved evidence bodies', '', 'This JSON appendix preserves each original evidence identifier and body. Parse the JSON to recover the exact supplied strings, including spacing and line breaks. The descriptions above do not replace those records. Source references are not fetched.', '',
    '```json', exactEvidenceJson(evidence), '```', '', connectionText, '',
  ].join('\n');
  return { filename: `${text(item.caseId, 'case').replace(/[^A-Za-z0-9_-]/g, '')}-decision-report.md`, text: result };
}
