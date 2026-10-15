import { createLocalObserver, redactTraceAttributes, isSafeTraceName } from './observability.mjs';

// Explicit, bounded, request-scoped recording. Never reads upload credentials,
// chooses a filesystem path, installs a global tracer or contacts a collector.
export function createHostedObserver({ env = {} } = {}) {
  if (env.REFUND_OFFICE_HOSTED_TRACING !== 'enabled') return undefined;
  return createLocalObserver({ projectName: 'refund-office-hosted-preparation', maxSpans: 128, maxBytes: 256 * 1024 });
}

export const HOSTED_TRACE_SCOPE = Object.freeze({
  storage: 'memory', durable: false, scope: 'request', uploaded: false,
  detail: 'Bounded metadata for this request only. Serverless restarts do not retain these traces. No Arize upload or durable hosted collection is configured.',
});

// An authenticated machine caller may save this bounded request result itself.
// This is a snapshot of completed spans, never a global or durable collector.
export function readHostedTrace(observer) {
  const absent = { ...HOSTED_TRACE_SCOPE, schemaVersion: 1, recordingAvailable: false, spans: [], incomplete: true };
  try {
    if (typeof observer?.snapshot !== 'function') return absent;
    const raw = observer.snapshot();
    let recorderFailed = false;
    try { const status = observer.status?.(); recorderFailed = !status || ['recordingErrors','writeErrors','droppedSpans'].some(key => !Number.isSafeInteger(status[key]) || status[key] < 0 || status[key] > 0); } catch { recorderFailed = true; }
    if (!Array.isArray(raw?.spans)) return absent;
    const spans = [];
    for (const value of raw.spans.slice(-128)) {
      if (!/^[a-f0-9]{32}$/.test(value.traceId || '') || !/^[a-f0-9]{16}$/.test(value.spanId || '') || !(value.parentSpanId === null || /^[a-f0-9]{16}$/.test(value.parentSpanId || '')) || !['OK','ERROR'].includes(value.status) || !/^[0-9]{1,22}$/.test(value.startTimeUnixNano || '') || !/^[0-9]{1,22}$/.test(value.endTimeUnixNano || '') || BigInt(value.endTimeUnixNano) < BigInt(value.startTimeUnixNano)) continue;
      spans.push({ traceId: value.traceId, spanId: value.spanId, parentSpanId: value.parentSpanId,
        name: isSafeTraceName(value.name) ? value.name : 'operation', kind: ['CHAIN','TOOL','LLM'].includes(value.kind) ? value.kind : 'TOOL', status: value.status,
        startTimeUnixNano: value.startTimeUnixNano, endTimeUnixNano: value.endTimeUnixNano, attributes: redactTraceAttributes(value.attributes) });
    }
    const safe = { ...HOSTED_TRACE_SCOPE, schemaVersion: 1, recordingAvailable: true, spans,
      incomplete: recorderFailed || spans.length !== raw.spans.length || raw.retention?.droppedSpans > 0 };
    return Buffer.byteLength(JSON.stringify(safe)) <= 256 * 1024 ? safe : absent;
  } catch { return absent; }
}
