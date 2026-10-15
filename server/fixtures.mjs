export const ORDERS = [
  {
    id: 'DEMO-104', label: 'DEMO-104 · £60 · one missing item', totalMinor: 6000, currency: 'gbp', synthetic: true,
    delivery: { status: 'delivered', disputed: false, detail: 'Parcel received; packing record identifies one omitted item.' },
    lines: [
      { id: '104-1', name: 'Blue notebook', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '104-2', name: 'Desk organiser', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '104-3', name: 'Travel mug', unitAmountMinor: 2000, ordered: 1, packed: 0 },
    ],
  },
  {
    id: 'DEMO-105', label: 'DEMO-105 · £60 · delivery disputed', totalMinor: 6000, currency: 'gbp', synthetic: true,
    delivery: { status: 'delivered', disputed: true, detail: 'Courier scan says delivered; customer reports no parcel. No photograph or recipient confirmation is supplied.' },
    lines: [
      { id: '105-1', name: 'Notebook set', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '105-2', name: 'Desk organiser', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '105-3', name: 'Travel mug', unitAmountMinor: 2000, ordered: 1, packed: 1 },
    ],
  },
  {
    id: 'DEMO-106', label: 'DEMO-106 · £60 · previous remedy', totalMinor: 6000, currency: 'gbp', synthetic: true,
    delivery: { status: 'delivered', disputed: false, detail: 'Parcel received; one omitted item already has its own seeded remedy.' },
    lines: [
      { id: '106-1', name: 'Notebook', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '106-2', name: 'Desk organiser', unitAmountMinor: 2000, ordered: 1, packed: 1 },
      { id: '106-3', name: 'Travel mug', unitAmountMinor: 2000, ordered: 1, packed: 0 },
    ],
  },
  {
    id: 'DEMO-107', label: 'DEMO-107 · £36 · missing pencil case', totalMinor: 3600, currency: 'gbp', synthetic: true,
    delivery: { status: 'delivered', disputed: false, detail: 'Parcel received; the pencil case was omitted from the packing record.' },
    lines: [
      { id: '107-1', name: 'Notebook', unitAmountMinor: 1200, ordered: 1, packed: 1 },
      { id: '107-2', name: 'Pen set', unitAmountMinor: 1200, ordered: 1, packed: 1 },
      { id: '107-3', name: 'Pencil case', unitAmountMinor: 1200, ordered: 1, packed: 0 },
    ],
  },
  {
    id: 'DEMO-108', label: 'DEMO-108 · £54 · missing desk mat', totalMinor: 5400, currency: 'gbp', synthetic: true,
    sampleComplaint: 'My notebook and pen set arrived, but the desk mat is missing. Please refund the missing desk mat.',
    delivery: { status: 'delivered', disputed: false, detail: 'Parcel received; the warehouse packing record confirms the desk mat was omitted.' },
    lines: [
      { id: '108-1', name: 'Notebook', unitAmountMinor: 1800, ordered: 1, packed: 1 },
      { id: '108-2', name: 'Pen set', unitAmountMinor: 1800, ordered: 1, packed: 1 },
      { id: '108-3', name: 'Desk mat', unitAmountMinor: 1800, ordered: 1, packed: 0 },
    ],
  },
];

export const SEED_CASES = [
  { id: 'missing-item', caseId: 'RF-104', title: 'One item missing', shortTitle: 'Missing item', orderId: 'DEMO-104', complaint: 'My parcel arrived, but the travel mug is missing. Please refund the item that was not sent.' },
  { id: 'conflicting-evidence', caseId: 'RF-105', title: 'Delivery evidence conflicts', shortTitle: 'Delivery issue', orderId: 'DEMO-105', complaint: 'I have not received my parcel. The tracking says delivered, but nothing arrived. Please investigate a refund.' },
  { id: 'repeat-request', caseId: 'RF-106', title: 'Same item, new request', shortTitle: 'Repeat request', orderId: 'DEMO-106', complaint: 'My parcel is missing the travel mug. Can you refund that missing item?' },
];

export function blankChecks() {
  return [
    { id: 'evidence', label: 'Evidence supports the claim', detail: 'Investigation has not started.', status: 'not_checked' },
    { id: 'amount', label: 'Amount matches the missing item', detail: 'No refund has been proposed.', status: 'not_checked' },
    { id: 'mandate', label: 'Within the refund policy limit', detail: 'Policy has not been checked.', status: 'not_checked' },
    { id: 'previous', label: 'No previous remedy', detail: 'The durable remedy register has not been checked.', status: 'not_checked' },
    { id: 'balance', label: 'Refundable balance is available', detail: 'Remaining order balance has not been checked.', status: 'not_checked' },
  ];
}

export function makeCase(input, orders = ORDERS) {
  const order = orders.find((item) => item.id === input.orderId);
  return { ...input, orderTotalMinor: order.totalMinor, proposedAmountMinor: 0, stage: 'reception', status: 'ready', outcome: null,
    summary: 'Ready to investigate the complaint against the supplied order records.', evidence: [], checks: blankChecks(), proposal: null,
    receipt: null, events: [], revision: 0, policySnapshot: null };
}
