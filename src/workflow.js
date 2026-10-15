export const SCENARIOS = [
  {
    id: 'missing-item',
    caseId: 'RF-104',
    title: 'One item missing',
    shortTitle: 'Missing item',
    orderTotal: 60,
    proposedRefund: 20,
    summary: 'Packing record confirms 2 of 3 items supplied.',
    complaint: 'My parcel arrived, but one of the three £20 items is missing. Please refund the item that was not sent.',
    evidence: [
      { title: 'Order details', source: 'Synthetic order · DEMO-104', body: 'Three items at £20 each. Total: £60 GBP. The missing item is line 3.' },
      { title: 'Packing record', source: 'Synthetic fulfilment record · PACK-104', body: 'Lines 1 and 2 were packed. Line 3 was omitted. Two of three items were supplied.' },
      { title: 'Previous remedies', source: 'Synthetic case register · DEMO-104', body: 'No earlier remedy is seeded for line 3. Replaying a completed case checks the remedy recorded in this browser session.' },
    ],
    policyChecks: [
      { label: 'Evidence supports the claim', detail: 'The packing record identifies the omitted order line.', result: 'pass' },
      { label: 'Refund matches the missing item', detail: 'One item at £20; proposed refund is £20 GBP.', result: 'pass' },
      { label: 'Within the demo mandate', detail: 'The synthetic policy permits evidenced refunds up to £25.', result: 'pass' },
      { label: 'No previous remedy', detail: 'The same order line has no recorded remedy at the start of this case.', result: 'pass' },
    ],
  },
  {
    id: 'conflicting-evidence',
    caseId: 'RF-105',
    title: 'Delivery evidence conflicts',
    shortTitle: 'Conflicting evidence',
    orderTotal: 60,
    proposedRefund: 20,
    summary: 'Delivery scan and customer report disagree. Review needed.',
    complaint: 'I have not received the parcel. The tracking page says delivered, but nothing was at my door. Please refund £20 while this is investigated.',
    evidence: [
      { title: 'Order details', source: 'Synthetic order · DEMO-105', body: 'Three items at £20 each. Total: £60 GBP. No omitted item is identified in the packing record.' },
      { title: 'Delivery scan', source: 'Synthetic courier record · DEL-105', body: 'The courier marked the parcel delivered. No delivery photograph or recipient confirmation is included.' },
      { title: 'Customer report', source: 'Synthetic message · MSG-105', body: 'The customer reports that no parcel arrived. The available records cannot resolve the conflict.' },
    ],
    policyChecks: [
      { label: 'Amount within the demo mandate', detail: 'The requested £20 is within the £25 limit.', result: 'pass' },
      { label: 'Evidence supports the claim', detail: 'The delivery scan conflicts with the customer report.', result: 'hold' },
      { label: 'Request the missing evidence', detail: 'A reviewer needs a delivery photograph or recipient confirmation before deciding a remedy.', result: 'hold' },
    ],
  },
  {
    id: 'repeat-request',
    caseId: 'RF-106',
    title: 'Same item, new request',
    shortTitle: 'Repeat request',
    orderTotal: 60,
    proposedRefund: 20,
    summary: 'A seeded £20 remedy already covers this missing item.',
    complaint: 'I paid for three items but only got two. Could you return the £20 for the one that never arrived?',
    evidence: [
      { title: 'Related order', source: 'Synthetic order · DEMO-104', body: 'This differently worded request refers to line 3 of the same £60 order used by RF-104.' },
      { title: 'Previous resolution', source: 'Seeded synthetic history · DEMO-REMEDY-104', body: 'A historical £20 remedy for missing line 3 is supplied as demo data. It exists for this scenario even before RF-104 is run.' },
      { title: 'Remedy comparison', source: 'Synthetic case comparison · RF-106 / RF-104', body: 'The order, order line and issue match the seeded remedy. No additional refund is due under the demo policy.' },
    ],
    policyChecks: [
      { label: 'Same order and missing item', detail: 'The request matches DEMO-104, line 3.', result: 'pass' },
      { label: 'Previous remedy found', detail: 'Seeded history already records a £20 remedy for this issue.', result: 'blocked' },
      { label: 'No additional refund', detail: 'The request is linked to its previous resolution and archived.', result: 'pass' },
    ],
  },
];

function getScenario(scenarioId) {
  const scenario = SCENARIOS.find((item) => item.id === scenarioId);
  if (!scenario) throw new RangeError(`Unknown demo scenario: ${scenarioId}`);
  return scenario;
}

// These are deterministic demo decisions, with no model or payment provider.
export function evaluateCase(scenarioId, alreadyResolved = false) {
  getScenario(scenarioId);
  if (scenarioId === 'repeat-request' || (scenarioId === 'missing-item' && alreadyResolved)) {
    return {
      outcome: 'already-resolved',
      amount: 0,
      reason: scenarioId === 'repeat-request'
        ? 'The seeded synthetic history already contains a £20 remedy for this order line. No additional refund is recorded.'
        : 'This browser session already recorded a £20 demo remedy for this order line. Replaying it records no additional refund.',
    };
  }
  if (scenarioId === 'conflicting-evidence') {
    return {
      outcome: 'held',
      amount: 0,
      reason: 'The delivery scan and customer report conflict. Request delivery evidence before deciding a remedy.',
    };
  }
  return {
    outcome: 'refunded',
    amount: 20,
    reason: 'The synthetic packing record confirms one missing £20 item. The demo policy permits a £20 remedy. No money moves.',
  };
}

const frame = (stage, station, label, detail, activity, tone, duration, terminal = false, outcome) => ({
  stage, station, label, detail, activity, tone, duration, terminal,
  ...(outcome ? { outcome } : {}),
});

export function getFrames(scenarioId, alreadyResolved = false) {
  const scenario = getScenario(scenarioId);
  const decision = evaluateCase(scenarioId, alreadyResolved);
  const frames = [
    frame(0, 'reception', 'Case received', 'The synthetic request is logged and linked to its order.', `${scenario.caseId} arrives at Reception`, 'working', 1800),
    frame(1, 'evidence', 'Checking evidence', scenario.summary, 'Comparing the supplied demo records', 'working', 3200),
    frame(2, 'policy', 'Checking policy', 'Checking evidence, the £25 demo limit and previous remedies.', 'Applying the fixed demo policy', 'working', 3200),
  ];

  if (decision.outcome === 'held') {
    frames.push(frame(2, 'review', 'Review needed', decision.reason, 'Case moved to Review · no refund recorded', 'warning', 0, true, 'held'));
    return frames;
  }

  if (decision.outcome === 'already-resolved') {
    frames.push(frame(2, 'archive', 'Already resolved', decision.reason, 'Linked to the previous remedy · no additional refund', 'success', 0, true, 'already-resolved'));
    return frames;
  }

  frames.push(
    frame(3, 'payments', 'Preparing demo refund', 'Recording a £20 synthetic remedy locally. No payment service is connected.', 'Preparing the local demo receipt', 'working', 3500),
    frame(4, 'archive', 'Demo refund recorded', '£20 synthetic remedy recorded for the missing item. No real money moved.', 'Case archived with its evidence and demo receipt', 'success', 0, true, 'refunded'),
  );
  return frames;
}
