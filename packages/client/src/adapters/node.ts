import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type WebHandler = (request: Request) => Response | Promise<Response>;

/** Translate one host invocation without buffering either request or response. */
export function createNodeHandler(handler: WebHandler, options: { trustProxy?: boolean; maxBodyBytes?: number } = {}) {
  return async function handleNodeRequest(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const bodyLimit = options.maxBodyBytes ?? 1024 * 1024;
    let bodyTooLarge = false;
    const rejectBody = () => { outgoing.statusCode = 413; outgoing.end('Payload Too Large'); incoming.resume(); };
    const disconnect = () => {
      if (!outgoing.writableFinished) controller.abort(new Error('Client disconnected'));
    };
    incoming.once('aborted', disconnect);
    outgoing.once('close', disconnect);
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      }
      const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
      const forwardedProtocol = options.trustProxy ? first(incoming.headers['x-forwarded-proto']) : undefined;
      const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
      const host = (options.trustProxy ? first(incoming.headers['x-forwarded-host']) : undefined) || incoming.headers.host || 'localhost';
      const target = incoming.url || '/';
      if (!target.startsWith('/')) { outgoing.statusCode = 400; outgoing.end('Invalid request target'); return; }
      // Concatenation keeps a //path request from replacing the host via URL resolution.
      const url = new URL(`${protocol}://${host}${target}`);
      const method = incoming.method || 'GET';
      const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
      if (method !== 'GET' && method !== 'HEAD') {
        const length = incoming.headers['content-length'];
        if (length !== undefined && Number(length) > bodyLimit) { rejectBody(); return; }
        let received = 0;
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.body = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, destination) {
            received += chunk.byteLength;
            if (received > bodyLimit) {
              bodyTooLarge = true;
              controller.abort(new Error('Request body limit exceeded'));
              throw new Error('Request body limit exceeded');
            }
            destination.enqueue(chunk);
          },
        }), { preventCancel: true });
        init.duplex = 'half';
      }
      const response = await handler(new Request(url, init));
      if (bodyTooLarge) { await response.body?.cancel(); rejectBody(); return; }
      if (!(response instanceof Response)) throw new TypeError('Zap handler must return a Web Response');
      if (controller.signal.aborted) {
        await response.body?.cancel(controller.signal.reason);
        return;
      }
      outgoing.statusCode = response.status;
      outgoing.statusMessage = response.statusText;
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      if (method === 'HEAD' || !response.body) {
        await response.body?.cancel();
        outgoing.end();
        return;
      }
      // pipeline pauses the Web reader when the host socket applies backpressure.
      outgoing.flushHeaders();
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing, { signal: controller.signal });
    } catch (error) {
      if (bodyTooLarge) { rejectBody(); return; }
      if (controller.signal.aborted) return;
      console.error('[zap] Request failed', error);
      if (outgoing.headersSent) outgoing.destroy(error instanceof Error ? error : undefined);
      else {
        outgoing.statusCode = 500;
        outgoing.setHeader('content-type', 'text/plain; charset=utf-8');
        outgoing.end('Internal Server Error');
      }
    } finally {
      incoming.off('aborted', disconnect);
      outgoing.off('close', disconnect);
    }
  };
}
