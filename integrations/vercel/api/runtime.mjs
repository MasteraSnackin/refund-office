import { Readable } from 'node:stream';
import { createHostedHandler } from '../../../server/hosted-api.mjs';
import { HostedError, hostedPublicSettings, requireHostedEnabled } from '../../../server/hosted-auth.mjs';
import { runtimeJsonBodyLimit } from '../../../server/canvas-voice.mjs';

export function createVercelRuntime({ env = process.env, handler = createHostedHandler({ env }) } = {}) {
  return async function vercelRuntime(request, response) {
    let detach = () => {};
    try {
      // Do not consume request credentials or bodies while deployment is off.
      requireHostedEnabled(env);
      const config = hostedPublicSettings(env), method = request.method || 'GET';
      const cancelled = new AbortController();
      const abort = () => cancelled.abort();
      const closed = () => { if (!response.writableEnded) abort(); };
      request.once?.('aborted', abort); response.once?.('close', closed);
      detach = () => { request.removeListener?.('aborted', abort); response.removeListener?.('close', closed); };
      if (request.aborted || response.destroyed && !response.writableEnded) abort();
      const url = new URL(request.url, config.origin), limit = runtimeJsonBodyLimit(url.pathname, method);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers || {})) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      let body;
      if (!['GET', 'HEAD'].includes(method)) {
        if (Number(headers.get('content-length')) > limit) throw new HostedError(413, 'body_too_large', 'The request is too large.');
        if (request.body !== undefined) {
          body = Buffer.isBuffer(request.body) || typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
          if (Buffer.byteLength(body) > limit) throw new HostedError(413, 'body_too_large', 'The request is too large.');
        } else {
          let size = 0;
          body = Readable.toWeb(request).pipeThrough(new TransformStream({ transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > limit) throw new HostedError(413, 'body_too_large', 'The request is too large.');
            controller.enqueue(chunk);
          } }));
        }
      }
      const result = await handler(new Request(url, { method, headers, signal: cancelled.signal, ...(body !== undefined ? { body, duplex: 'half' } : {}) }));
      const bytes = Buffer.from(await result.arrayBuffer());
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = result.status;
      for (const [key, value] of result.headers) response.setHeader(key, value);
      response.end(bytes);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = error.status === 413 ? 413 : 503;
      response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({ error: { code: error.code === 'body_too_large' ? error.code : 'hosted_unavailable', message: 'The hosted request is unavailable. Check the explicit configuration and request size.' } }));
    }
    finally { detach(); }
  };
}
export default createVercelRuntime();
