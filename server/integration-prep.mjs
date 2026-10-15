// Preparation only: these helpers read saved case packets and never contact a provider.
import { buildCaseProvenance } from './case-provenance.mjs';
const text = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const money = (minor) => Number.isSafeInteger(minor) && minor >= 0 ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100) : 'an unconfirmed amount';
const sentence = (value) => { const clean = text(value); return /[.!?]$/.test(clean) ? clean : `${clean}.`; };
const markdown = (value) => text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|])/g, '\\$1');

export function getIntegrationStatus({ capabilities = {} } = {}) {
  const external = capabilities.networkMode === 'external-enabled';
  const openai = external && capabilities.analyser === 'openai' && capabilities.modelConfigured === true;
  const anthropic = external && capabilities.analyser === 'anthropic' && capabilities.modelConfigured === true;
  const stripe = external && capabilities.payments === 'stripe-sandbox' && capabilities.stripeConfigured === true;
  return {
    mode: external ? 'external-enabled' : 'offline',
    humanApprovalRequired: true,
    providers: [
      { id: 'openai', name: 'OpenAI', role: 'Investigate and propose a refund', status: openai ? 'configured-unverified' : 'adapter-disconnected', detail: openai ? 'The adapter is configured. This status does not verify credentials, credits or a successful request. Proposals cannot authorise payments.' : `An optional adapter is implemented. ${anthropic ? 'Anthropic is the selected analyser.' : 'Current analysis uses local rules.'} No OpenAI call is made.` },
      { id: 'anthropic', name: 'Anthropic', role: 'Provide an alternative evidence-based proposal', status: anthropic ? 'configured-unverified' : 'adapter-disconnected', detail: anthropic ? 'The selected Messages adapter is configured. Credentials and output are unverified. Deterministic checks and human approval still apply.' : 'A structured-proposal adapter and optional independent second-opinion comparison are prepared. Both remain disconnected; model agreement cannot authorise payment.' },
      { id: 'elevenlabs', name: 'ElevenLabs', role: 'Read a saved case briefing aloud', status: 'adapter-disconnected', detail: 'The case action can generate and play a saved briefing after explicit configuration, with a durable request record. Voice services are disconnected; current briefings remain text.' },
      { id: 'n8n', name: 'n8n', role: 'Receive requests and queue investigation', status: 'adapter-disconnected', detail: 'Inactive workflows and a protected hosted intake hook are prepared. The working local queue is application code, not an n8n execution. Intake has no payment authority.' },
      { id: 'supabase', name: 'Supabase', role: 'Verify workspace access and store case records', status: 'adapter-disconnected', detail: 'Working-store migrations, verified sign-in code and a hosted API are prepared. The separate PostgreSQL rehearsal uses local test profiles. No Supabase service is connected.' },
      { id: 'vercel', name: 'Vercel', role: 'Host a shareable interface', status: 'prepared', detail: 'A separate hosted API entry point and deployment configuration are prepared alongside the earlier static template. No deployment has been made.' },
      { id: 'miro', name: 'Miro', role: 'Map saved sources, decisions and report destinations', status: 'adapter-disconnected', detail: 'A prepared source map distinguishes gathered evidence, cited records, human decisions and available reports. The disconnected publishing action verifies every note and connector through saved identities. Downloaded JSON is not a native Miro import file.' },
      { id: 'modal', name: 'Modal', role: 'Process supplied evidence text in isolated jobs', status: 'adapter-disconnected', detail: 'A case action can process saved evidence text and verify returned lines without changing the evidence or decision. It is disconnected; uploads and OCR are not implemented.' },
      { id: 'stripe', name: 'Stripe', role: 'Execute and independently verify an approved test refund', status: stripe ? 'configured-unverified' : 'adapter-disconnected', detail: stripe ? 'The test-only adapter is configured. This status does not verify credentials or a completed refund. Explicit human approval is still required.' : 'The original simulator and a separate gated test-execution module are available in code. The PostgreSQL preview cannot submit payments; old reservations grant no Stripe authority.' },
      { id: 'port', name: 'Port', role: 'Catalogue services, owners and readiness', status: 'adapter-disconnected', detail: 'A metadata-only case action can publish and independently retrieve service readiness. It is disconnected; catalogue metadata grants no deployment or refund authority.' },
    ],
  };
}

function savedCase(packet) {
  if (!packet?.case || typeof packet.case.id !== 'string' || !Number.isSafeInteger(packet.case.revision)) throw new TypeError('A saved case export with a revision is required.');
  return packet.case;
}

function paymentSummary(packet) {
  const item = packet.case;
  const operation = packet.operation;
  const receipt = operation?.receipt || item.receipt;
  if (item.outcome === 'already-resolved') return `An existing remedy covers this issue. No new refund was created.${receipt ? ` Saved receipt ${text(receipt.id)} reports ${text(receipt.status)}.` : ''}`;
  if (receipt?.status === 'succeeded') {
    if (receipt.provider === 'local') return `A local simulation recorded ${money(receipt.amountMinor)}. No real money moved. Receipt: ${text(receipt.id)}.`;
    if (receipt.provider === 'stripe-sandbox' && receipt.livemode === false) return `A Stripe test refund of ${money(receipt.amountMinor)} was confirmed. No real money moved. Receipt: ${text(receipt.id)}.`;
    return 'A saved receipt reports success, but its supported provider and test mode are not established in this export. Review the original record.';
  }
  if (operation?.status === 'failed' || ['failed', 'canceled'].includes(receipt?.status)) return 'The saved payment operation failed. No successful refund is claimed and no replacement is authorised.';
  if (operation?.submittedAt || operation?.status === 'pending' || receipt) return 'The payment result is not confirmed. Reconcile the existing operation before considering any further payment.';
  if (operation) return `${money(operation.amountMinor)} is reserved in the saved operation. It has not been submitted and is not a completed refund.`;
  return 'No payment operation or successful refund is recorded for this case.';
}

function nextAction(packet) {
  const item = packet.case;
  if (item.outcome === 'already-resolved') return 'Inspect the existing remedy and receipt. Do not create a second refund for the same issue.';
  if (item.status === 'closed') return 'The case is closed without refund. Reopen it only if new information warrants another investigation.';
  if (item.status === 'complete') return 'Inspect the saved receipt and history, then retain this report with the case.';
  if (packet.operation?.status === 'failed') return 'Review the failed operation. Do not create an automatic replacement payment.';
  if (packet.operation?.submittedAt || item.status === 'pending') return 'Reconcile the saved operation. A missing confirmation is not permission to issue another refund.';
  if (item.outcome === 'awaiting-approval' && item.approval?.state === 'required') return `Review the evidence and exact ${money(item.approval.amountMinor)} recommendation. A human must explicitly approve it before payment can be submitted.`;
  if (packet.operation && item.approval?.state === 'approved') return 'The human decision and exact operation are saved. Continue the approved payment step; submission has not yet been confirmed.';
  if (item.review?.state === 'awaiting-evidence') return 'Obtain the evidence recorded in the review note. The request is an internal note; no customer message has been sent.';
  if (item.status === 'review' || item.status === 'error') return 'Inspect the unresolved checks and record a human review decision. No new refund is authorised.';
  if (item.status === 'paused') return 'Resume the saved investigation when ready. Human approval is still required before a new refund.';
  return 'Continue investigation of the supplied records. Stop for human review before any new refund.';
}

export function buildBriefing(packet) {
  const item = savedCase(packet);
  const approval = packet.operation?.approval || item.approval;
  const checks = Array.isArray(item.checks) ? item.checks : [];
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const source = ['openai', 'anthropic'].includes(item.proposal?.source) ? `Saved ${item.proposal.source === 'openai' ? 'OpenAI' : 'Anthropic'} proposal; deterministic checks still control eligibility.` : item.proposal?.source === 'local' ? 'Saved local rule-based proposal; no model call.' : 'No saved analyser proposal is available.';
  const decision = approval?.state === 'approved'
    ? `Explicit local approval for ${money(approval.amountMinor)} was recorded at ${text(approval.decidedAt)}. Reviewer note: ${sentence(approval.note)} The reviewer label is not an authenticated identity.`
    : approval?.state === 'required' ? `Human approval is required for ${money(approval.amountMinor)} and has not been granted.`
      : approval?.state === 'invalidated' ? `The prior approval is invalidated: ${text(approval.reason)}. A fresh review is required.`
        : 'No human refund approval is recorded for this case.';
  const sections = [
    { heading: 'Case', text: `${text(item.caseId || item.id)}: ${text(item.title)}. Order ${text(item.orderId)}. Saved revision ${item.revision}. ${packet.dataMode === 'synthetic-orders' ? 'Order records are synthetic demonstration data.' : 'The data mode is not established.'} Customer report: ${text(item.complaint)}` },
    { heading: 'Investigation', text: `${text(item.summary)} ${source}${item.proposal ? ` Proposed amount: ${money(item.proposedAmountMinor)}. Reason: ${text(item.proposal.reason)}` : ''}` },
    { heading: 'Evidence snapshot', text: evidence.length ? 'These records were gathered during investigation. They may predate the current payment result.\n' + evidence.map(entry => `${text(entry.title)} (${text(entry.id)}): ${text(entry.body)}`).join('\n') : 'No evidence has been gathered yet.' },
    { heading: 'Saved policy checks', text: checks.length ? 'These are saved investigation or pre-submission checks, not current payment status. The current saved payment result is shown below.\n' + checks.map(check => `${text(check.label)}: ${text(check.status)}. ${text(check.detail)}`).join('\n') : 'No policy checks are saved.' },
    { heading: 'Human decision', text: `${decision}${item.review ? ` Review state: ${text(item.review.state)}. Recorded reason: ${text(item.review.note)}` : ''}` },
    { heading: 'Payment', text: paymentSummary(packet) },
    { heading: 'Next action', text: nextAction(packet) },
  ];
  return { caseId: item.caseId || item.id, revision: item.revision, title: `Briefing: ${text(item.title)}`, mode: 'local-text', text: sections.map(section => `${section.heading}\n${section.text}`).join('\n\n'), sections,
    audio: { available: false, provider: 'elevenlabs', reason: 'ElevenLabs is disconnected. This is a saved-evidence text briefing, with no generated audio.' } };
}

export function buildDecisionReport(packet) {
  const briefing = buildBriefing(packet);
  const provider = packet.operation?.provider || packet.capabilities?.payments;
  const paymentMode = provider === 'local' ? 'Local payment simulation; no real money moves.' : provider === 'stripe-sandbox' ? 'Stripe test mode; no live payment is supported.' : 'Payment provider not established.';
  return [
    `# Refund Office decision report: ${markdown(briefing.caseId)}`,
    `Saved case revision: ${briefing.revision}.`,
    'This report is generated locally from saved records. It is not a new model assessment or an approval action.',
    `Payment mode: ${paymentMode}`,
    ...briefing.sections.map(section => `## ${section.heading}\n\n${section.text.split('\n').map(markdown).join('\n\n')}`),
    '## Scope\n\nEvery new refund requires explicit human approval. External integration configuration does not establish provider availability. Local reviewer labels are not authenticated identities. This report does not send a message or move money.',
  ].join('\n\n') + '\n';
}

export function buildMiroExport(packet) {
  return buildCaseProvenance(packet);
}
