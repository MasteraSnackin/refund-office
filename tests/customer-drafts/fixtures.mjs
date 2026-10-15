export function draftPacket() {
  const order = { id: 'SYN-O1', synthetic: true, currency: 'gbp', totalMinor: 1800, lines: [
    { id: 'SYN-L1', name: 'Sketchbook', ordered: 1, packed: 0, unitAmountMinor: 1000 },
    { id: 'SYN-L2', name: 'Marker set', ordered: 1, packed: 0, unitAmountMinor: 500 },
    { id: 'SYN-L3', name: 'Paper clips', ordered: 1, packed: 1, unitAmountMinor: 300 },
  ], delivery: { status: 'delivered', disputed: false, detail: 'Synthetic parcel recorded as delivered.' } };
  return { schemaVersion: 1, synthetic: true, order, case: {
    id: 'SYN-C1', caseId: 'RF-2008', orderId: order.id, revision: 4, status: 'review', stage: 'review', outcome: 'held',
    complaint: 'Some items are missing from my order.', approval: null, operationId: null, receipt: null,
    fingerprint: null, proposal: { issue: 'unknown', amountMinor: 0, lineId: null, evidenceIds: [] }, checks: [],
    evidence: [
      { id: 'order:SYN-O1', source: 'Synthetic catalogue', body: JSON.stringify(order) },
      { id: 'packing:SYN-O1', source: 'Synthetic catalogue', body: JSON.stringify(order.lines) },
      { id: 'delivery:SYN-O1', source: 'Synthetic catalogue', body: JSON.stringify(order.delivery) },
      { id: 'remedies:SYN-O1', source: 'Operational database', body: '[]' },
    ],
  } };
}

