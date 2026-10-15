import { createHash } from 'node:crypto';

export class DemoDatasetError extends Error {
  constructor(message) { super(message); this.name = 'DemoDatasetError'; this.code = 'invalid_demo_dataset'; }
}
const fail = message => { throw new DemoDatasetError(message); };
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
function text(value, label, min = 1, max = 1000) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label} must be bounded plain text.`);
}
function identifier(value, label) { if (typeof value !== 'string' || !idPattern.test(value)) fail(`${label} must be a bounded local identifier.`); }
function object(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains an unsupported field: ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}.`);
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be a whole number in the permitted range.`); }
function unique(set, value, label) { if (set.has(value)) fail(`${label} must be unique.`); set.add(value); }
function date(value, label) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be an ISO UTC timestamp.`); }

// Dataset files are local synthetic fixtures, never serialized runtime state.
// A strict allowlist prevents a fixture from smuggling approvals, providers,
// execution stages, live payment identifiers or previously captured decisions.
export function validateDemoDataset(value) {
  const keys = ['schemaVersion', 'id', 'synthetic', 'title', 'merchant', 'policy', 'orders', 'cases', 'seedOperations', 'scenarios'];
  object(value, keys, keys.filter(key => key !== 'seedOperations'), 'Dataset');
  if (value.schemaVersion !== 1 || !['focused-12', 'busy-50'].includes(value.id) || value.synthetic !== true) fail('Use a supported, explicitly synthetic version-one demo dataset.');
  text(value.title, 'Dataset title', 1, 160);
  object(value.merchant, ['id', 'name', 'currency', 'synthetic'], ['id', 'name', 'currency', 'synthetic'], 'Merchant');
  identifier(value.merchant.id, 'Merchant ID'); text(value.merchant.name, 'Merchant name', 1, 160);
  if (value.merchant.synthetic !== true || value.merchant.currency !== 'gbp') fail('The demo merchant must be synthetic and use GBP.');
  object(value.policy, ['limitMinor', 'version'], ['limitMinor', 'version'], 'Policy');
  integer(value.policy.limitMinor, 'Policy limit', 0, 100000);
  if (value.policy.version !== 1) fail('A new dataset must start at policy version one.');
  if (!Array.isArray(value.orders) || value.orders.length < 1 || value.orders.length > 500) fail('Supply between one and 500 synthetic orders.');
  const orders = new Map(); const lineIds = new Set();
  for (const order of value.orders) {
    object(order, ['id', 'label', 'totalMinor', 'currency', 'synthetic', 'delivery', 'lines', 'sampleComplaint'], ['id', 'label', 'totalMinor', 'currency', 'synthetic', 'delivery', 'lines'], 'Order');
    identifier(order.id, 'Order ID'); if (orders.has(order.id)) fail('Order IDs must be unique.'); orders.set(order.id, order);
    text(order.label, 'Order label', 1, 200); integer(order.totalMinor, 'Order total', 1);
    if (order.currency !== 'gbp' || order.synthetic !== true) fail('Every order must be explicitly synthetic and use GBP.');
    if (order.sampleComplaint !== undefined) text(order.sampleComplaint, 'Sample complaint', 8, 4000);
    object(order.delivery, ['status', 'disputed', 'detail'], ['status', 'disputed', 'detail'], 'Delivery');
    text(order.delivery.status, 'Delivery status', 1, 80); text(order.delivery.detail, 'Delivery detail', 1, 2000);
    if (typeof order.delivery.disputed !== 'boolean') fail('Delivery dispute state must be a boolean.');
    if (!Array.isArray(order.lines) || order.lines.length < 1 || order.lines.length > 50) fail('Each order needs one to 50 lines.');
    let total = 0;
    for (const line of order.lines) {
      object(line, ['id', 'name', 'unitAmountMinor', 'ordered', 'packed'], ['id', 'name', 'unitAmountMinor', 'ordered', 'packed'], 'Order line');
      identifier(line.id, 'Line ID'); unique(lineIds, line.id, 'Line IDs'); text(line.name, 'Item name', 1, 160);
      integer(line.unitAmountMinor, 'Unit price', 1); integer(line.ordered, 'Ordered quantity', 1, 100); integer(line.packed, 'Packed quantity', 0, line.ordered);
      const subtotal = line.unitAmountMinor * line.ordered;
      integer(subtotal, 'Line total', 1); total += subtotal; integer(total, 'Calculated order total', 1);
    }
    if (total !== order.totalMinor) fail('The order total must equal the sum of ordered quantities and prices.');
  }
  const count = value.id === 'focused-12' ? 12 : 50;
  if (!Array.isArray(value.cases) || value.cases.length !== count || value.cases.length > 500) fail(`The ${value.id} dataset must contain exactly ${count} fresh cases.`);
  const cases = new Map(); const labels = new Set();
  for (const item of value.cases) {
    const fields = ['id', 'caseId', 'title', 'shortTitle', 'orderId', 'complaint'];
    object(item, fields, fields, 'Seed case'); identifier(item.id, 'Case ID');
    if (cases.has(item.id)) fail('Internal case IDs must be unique.'); cases.set(item.id, item);
    if (typeof item.caseId !== 'string' || !/^RF-[0-9]{1,12}$/.test(item.caseId)) fail('Each case needs a local RF number.');
    unique(labels, item.caseId, 'Displayed case numbers');
    text(item.title, 'Case title', 1, 200); text(item.shortTitle, 'Short case title', 1, 80); text(item.complaint, 'Complaint', 8, 4000);
    if (item.complaint !== item.complaint.trim()) fail('Seed complaints must not contain outer whitespace.');
    if (!orders.has(item.orderId)) fail('Every case must refer to a supplied order.');
  }
  const operations = value.seedOperations || [];
  if (!Array.isArray(operations) || operations.length > 500) fail('Seed history must contain no more than 500 operations.');
  const operationIds = new Set(); const operationKeys = new Set(); const receipts = new Set(); const remedies = new Set(); const used = new Map();
  for (const operation of operations) {
    const fields = ['id', 'orderId', 'lineId', 'issue', 'amountMinor', 'status', 'seeded', 'provider', 'idempotencyKey', 'createdAt', 'payload', 'receipt'];
    object(operation, fields, fields, 'Seed operation'); identifier(operation.id, 'Seed operation ID'); unique(operationIds, operation.id, 'Seed operation IDs');
    if (operation.provider !== 'local' || operation.seeded !== true || operation.status !== 'succeeded' || operation.issue !== 'item_missing') fail('History must be an explicitly seeded successful local missing-item remedy.');
    const order = orders.get(operation.orderId); const line = order?.lines.find(entry => entry.id === operation.lineId);
    if (!line || operation.amountMinor !== (line.ordered - line.packed) * line.unitAmountMinor) fail('The seeded amount must match the supplied missing quantity and price.');
    integer(operation.amountMinor, 'Seeded remedy amount', 1);
    unique(remedies, `${operation.orderId}:${operation.lineId}:${operation.issue}`, 'Historical remedies');
    used.set(order.id, (used.get(order.id) || 0) + operation.amountMinor);
    if (used.get(order.id) > order.totalMinor) fail('Historical remedies cannot exceed the order total.');
    if (typeof operation.idempotencyKey !== 'string' || !/^refund-office-seed-[A-Za-z0-9_-]{1,120}$/.test(operation.idempotencyKey)) fail('Seed history needs a clearly local seeded retry key.');
    unique(operationKeys, operation.idempotencyKey, 'Seeded retry keys'); date(operation.createdAt, 'Seed operation date');
    const payloadFields = ['operationId', 'idempotencyKey', 'order', 'amountMinor', 'lineId', 'issue'];
    object(operation.payload, payloadFields, payloadFields, 'Seed payload');
    const expected = { operationId: operation.id, idempotencyKey: operation.idempotencyKey, order, amountMinor: operation.amountMinor, lineId: line.id, issue: operation.issue };
    if (canonical(operation.payload) !== canonical(expected)) fail('Seed payload must match its exact local operation and supplied order.');
    const receipt = operation.receipt;
    const receiptFields = ['id', 'provider', 'amountMinor', 'currency', 'status', 'createdAt', 'operationId', 'seeded'];
    object(receipt, receiptFields, receiptFields, 'Seed receipt');
    if (typeof receipt.id !== 'string' || !/^DEMO-[A-Za-z0-9_-]{1,120}$/.test(receipt.id)) fail('Seed receipts must have an explicit DEMO identifier.');
    unique(receipts, receipt.id, 'Synthetic receipt IDs'); date(receipt.createdAt, 'Seed receipt date');
    if (receipt.seeded !== true || receipt.provider !== 'local' || receipt.currency !== 'gbp' || receipt.status !== 'succeeded' || receipt.operationId !== operation.id || receipt.amountMinor !== operation.amountMinor || receipt.createdAt !== operation.createdAt) fail('The synthetic receipt must match its seeded operation exactly.');
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== value.cases.length) fail('Provide one scenario expectation per case.');
  const scenarios = new Map();
  for (const scenario of value.scenarios) {
    object(scenario, ['caseId', 'category', 'expectedOutcome', 'expectedAmountMinor', 'dependsOn'], ['caseId', 'category', 'expectedOutcome'], 'Scenario');
    if (!cases.has(scenario.caseId) || scenarios.has(scenario.caseId)) fail('Scenarios must refer to each supplied case exactly once.'); scenarios.set(scenario.caseId, scenario);
    text(scenario.category, 'Scenario category', 1, 80);
    if (!['awaiting-approval', 'held', 'already-resolved'].includes(scenario.expectedOutcome)) fail('Scenario expectations cannot claim a fresh payment or human approval.');
    if (scenario.expectedAmountMinor !== undefined) integer(scenario.expectedAmountMinor, 'Expected amount', 0, orders.get(cases.get(scenario.caseId).orderId).totalMinor);
    if (scenario.dependsOn !== undefined && (!cases.has(scenario.dependsOn) || scenario.dependsOn === scenario.caseId)) fail('A scenario dependency must refer to a different supplied case.');
  }
  for (const scenario of scenarios.values()) {
    const seen = new Set([scenario.caseId]); let dependency = scenario.dependsOn;
    while (dependency) { if (seen.has(dependency)) fail('Scenario dependencies cannot contain cycles.'); seen.add(dependency); dependency = scenarios.get(dependency)?.dependsOn; }
  }
  return structuredClone({ ...value, seedOperations: operations });
}

export function demoDatasetDigest(value) { return createHash('sha256').update(canonical(validateDemoDataset(value))).digest('hex'); }
export function demoIntakePayloadHash(orderId, complaint) { return createHash('sha256').update(JSON.stringify({ orderId, complaint: complaint.trim() })).digest('hex'); }
