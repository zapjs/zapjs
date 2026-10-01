import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createNodeHandler, type WebHandler } from './node.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function listen(handler: WebHandler, maxBodyBytes?: number) {
  const server = createServer(createNodeHandler(handler, { maxBodyBytes }));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}

test('preserves binary request/response bodies and separate cookies', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const url = await listen(async request => {
    expect(request.headers.get('x-marker')).toBe('present');
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; HttpOnly; Path=/');
    return new Response(await request.arrayBuffer(), { status: 201, headers });
  });
  const response = await fetch(url, { method: 'POST', body: bytes, headers: { 'x-marker': 'present' } });
  expect(response.status).toBe(201);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly; Path=/']);
});

test('streams the first bytes before a later chunk becomes available', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const encoder = new TextEncoder();
  const url = await listen(() => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('first'));
      await waiting;
      controller.enqueue(encoder.encode('last'));
      controller.close();
    },
  })));
  const response = await fetch(url);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  finish();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
  expect((await reader.read()).done).toBe(true);
});

test('client disconnect aborts the Web request and cancels the response stream', async () => {
  let aborted!: () => void;
  let cancelled!: () => void;
  const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
  const cancelObserved = new Promise<void>(resolve => { cancelled = resolve; });
  const url = await listen(request => {
    request.signal.addEventListener('abort', aborted, { once: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled(); },
    }));
  });
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  await response.body!.getReader().read();
  controller.abort();
  await Promise.all([abortObserved, cancelObserved]);
});

test('HEAD returns headers without reading the response body', async () => {
  let cancelled = false;
  const url = await listen(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'x-head': 'yes' },
  }));
  const response = await fetch(url, { method: 'HEAD' });
  expect(response.headers.get('x-head')).toBe('yes');
  expect(await response.text()).toBe('');
  expect(cancelled).toBe(true);
});


test('rejects declared and chunked requests above the configured byte limit', async () => {
  const url = await listen(async request => new Response(await request.text()), 4);
  const declared = await fetch(url, { method: 'POST', body: 'oversized' });
  expect(declared.status).toBe(413);
  const { request } = await import('node:http');
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(url, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    outgoing.on('error', reject);
    outgoing.write('123');
    outgoing.end('456');
  });
  expect(chunked).toBe(413);
});

test('origin-form double slash remains a path rather than changing the request host', async () => {
  const url = await listen(request => Response.json({ url: request.url }));
  const response = await fetch(`${url}//attacker.example/path`);
  const actual = new URL((await response.json()).url);
  expect(actual.host).toBe(new URL(url).host);
  expect(actual.pathname).toContain('attacker.example/path');
});

test('a paused host socket applies backpressure instead of draining the response producer', async () => {
  const { get } = await import('node:http');
  let produced = 0;
  let finish!: () => void;
  const cancelled = new Promise<void>(resolve => { finish = resolve; });
  const url = await listen(() => new Response(new ReadableStream({
    pull(controller) {
      produced++;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (produced === 10_000) controller.close();
    },
    cancel() { finish(); },
  })));
  await new Promise<void>((resolve, reject) => {
    const request = get(url, response => {
      response.pause();
      setTimeout(() => {
        expect(produced).toBeLessThan(10_000);
        response.destroy();
        resolve();
      }, 30);
    });
    request.on('error', reject);
  });
  await cancelled;
});
