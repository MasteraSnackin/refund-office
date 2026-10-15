const RUN_HEADER = 'x-refund-demo-run';
const runIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function bindRunApi(runId, transport = api) {
  if (runId !== undefined && !runIdPattern.test(runId || '')) throw new Error('The rehearsal identity could not be verified. Refresh the local session.');
  const request = (path, options = {}) => transport(path, { ...options, runId, acceptRunChange: false });
  Object.defineProperty(request, 'runId', { value: runId });
  return request;
}
export async function api(path, { method = 'GET', body, signal, runId, acceptRunChange = false } = {}) {
  if (runId !== undefined && !runIdPattern.test(runId || '')) throw new Error('The saved rehearsal identity is invalid. No request was sent.');
  const response = await fetch(`/api${path}`, {
    method, signal, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(runId ? { [RUN_HEADER]: runId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (runId && !(acceptRunChange === true && path === '/demo/reset') && response.headers.get(RUN_HEADER) !== runId) {
    const error = new Error('This office belongs to an earlier rehearsal. Its response was not applied. Check the current local session.');
    error.status = 409; error.code = 'demo_run_changed'; error.uncertain = method !== 'GET';
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('refund-office:session-expired'));
    throw error;
  }
  let result;
  try { result = await response.json(); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Unexpected result shape'); }
  catch {
    const error = new Error('The local service returned an unreadable result. Inspect the saved case before retrying the original request.');
    error.status = response.status; error.code = 'unverified_response'; error.uncertain = method !== 'GET';
    if (response.status === 401 && path !== '/session' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('refund-office:session-expired'));
    throw error;
  }
  if (!response.ok) {
    const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'The local service could not complete this action.');
    error.status = response.status;
    error.code = result.error?.code || result.code;
    error.uncertain = result.error?.uncertain === true || result.uncertain === true;
    if ((response.status === 401 && path !== '/session' || error.code === 'demo_run_changed') && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('refund-office:session-expired'));
    }
    throw error;
  }
  return result;
}

export async function readRunDownload(href, runId, { signal } = {}) {
  if (!runIdPattern.test(runId || '') || !/^\/api\/cases\/[^/?#]+(?:\/(export|report|board-export))?$/.test(href)) throw new Error('This download could not be matched to the displayed rehearsal.');
  const response = await fetch(href, { method: 'GET', credentials: 'same-origin', signal, headers: { [RUN_HEADER]: runId } });
  if (response.headers.get(RUN_HEADER) !== runId) {
    const error = new Error('This file belongs to another rehearsal. Nothing was downloaded. Check the current local session.');
    error.status = 409; error.code = 'demo_run_changed';
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('refund-office:session-expired'));
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('refund-office:session-expired'));
    throw new Error('The saved case file could not be downloaded. Check access and try again.');
  }
  const blob = await response.blob();
  const suppliedName = response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1];
  const filename = suppliedName?.replace(/[^a-zA-Z0-9._-]/g, '_') || (href.endsWith('/report') ? 'decision-brief.md' : /\/(export|board-export)$/.test(href) ? 'decision-packet.json' : 'saved-case.json');
  return { blob, filename };
}
