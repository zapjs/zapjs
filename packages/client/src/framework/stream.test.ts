import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'parse5';
import { injectFlight, limitFlight } from './stream.js';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); } });
const collect = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
function scripts(html: string): { payload: Buffer; withoutFlight: string; count: number } {
  const sandbox = { self: {} as { __FLIGHT_DATA?: (string | Uint8Array)[] }, atob, Uint8Array };
  let count = 0;
  // Parse HTML to find executable script nodes; regexp alone would count scripts
  // accidentally inserted into attributes, comments, raw text, or templates.
  const walk = (node: any, inert = false, parentTag?: string) => {
    const blocked = inert || ['template', 'svg', 'math', 'noscript'].includes(node.tagName);
    if (node.tagName === 'script' && !blocked) {
      const text = node.childNodes.map((child: any) => child.value || '').join('');
      if (text.startsWith('(self.__FLIGHT_DATA')) {
        expect(['head', 'body']).toContain(parentTag);
        runInNewContext(text, sandbox); count++;
      }
    }
    for (const child of node.childNodes || []) walk(child, blocked, node.tagName);
  };
  walk(parse(html));
  return {
    count,
    payload: Buffer.concat((sandbox.self.__FLIGHT_DATA || []).map(value => typeof value === 'string' ? Buffer.from(value) : Buffer.from(value))),
    withoutFlight: html.replace(/<script>\(self\.__FLIGHT_DATA[\s\S]*?<\/script>/g, ''),
  };
}

test('preserves HTML and Flight across every single-byte boundary, including raw text, comments, attributes, template and foreign markup', async () => {
  const html = '<!doctype html><html><head><title>Hi 🦀</title><style>a:before{content:"<"}</style></head><body><div title="<quoted>">你好</div><!-- <script> --><textarea>&lt;hi&gt;</textarea><template><p>inert</p></template><svg><text>foreign</text></svg><math><mi>x</mi></math><script>self.original="</not-script>"</script></body></html>';
  const input = bytes(html);
  const result = scripts(await collect(injectFlight(stream([...input].map(byte => Uint8Array.of(byte))), stream([bytes('payload <script><!-- 😀')]))));
  expect(result.count).toBe(1);
  expect(result.payload.toString()).toBe('payload <script><!-- 😀');
  expect(result.withoutFlight).toBe(html);
});

test('does not insert inside an attribute split across event-loop turns', async () => {
  const html = new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(bytes('<html><body><div title="first'));
    await pause(20);
    controller.enqueue(bytes(' second">content</div></body></html>'));
    controller.close();
  } });
  const output = await collect(injectFlight(html, stream([bytes('payload')])));
  expect(output).not.toContain('title="first<script');
  const result = scripts(output);
  expect(result.payload.toString()).toBe('payload');
  expect(result.withoutFlight).toBe('<html><body><div title="first second">content</div></body></html>');
});

test('preserves split and invalid UTF-8, BOM, and large binary Flight records without argument spread', async () => {
  const chunks = [Uint8Array.of(0xe2), Uint8Array.of(0xff), bytes('\ufefftext'), new Uint8Array(256 * 1024).fill(255), bytes('</script><!--')];
  const expected = Buffer.concat(chunks);
  const result = scripts(await collect(injectFlight(stream([bytes('<html><body>shell</body></html>')]), stream([...chunks]))));
  expect(result.payload.equals(expected)).toBe(true);
  expect(result.count).toBe(chunks.length);
});

test('emits the shell before delayed HTML and retains closing document tags until Flight completes', async () => {
  let finishHtml!: () => void, finishFlight!: () => void;
  const html = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes('<html><body><p>shell</p>'));
    finishHtml = () => { controller.enqueue(bytes('<p>late</p></body></html>')); controller.close(); };
  } });
  const flight = new ReadableStream<Uint8Array>({ start(controller) { finishFlight = () => { controller.enqueue(bytes('late-flight')); controller.close(); }; } });
  const reader = injectFlight(html, flight).getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('shell');
  finishHtml();
  finishFlight();
  let output = first;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
  expect(output.endsWith('</body></html>')).toBe(true);
  expect(scripts(output).payload.toString()).toBe('late-flight');
});

test('pausing output demand does not drain the Flight producer', async () => {
  let produced = 0;
  const flight = new ReadableStream<Uint8Array>({ pull(controller) { if (produced++ < 128) controller.enqueue(bytes('x'.repeat(4096))); else controller.close(); } });
  const reader = injectFlight(stream([bytes('<html><body>shell</body></html>')]), flight).getReader();
  await reader.read();
  await pause(20);
  expect(produced).toBeLessThanOrEqual(2);
  await reader.cancel();
});

test('cancels both input readers even when waiting for a Flight chunk', async () => {
  let htmlCancelled = false, flightCancelled = false;
  const html = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes('<html><body>shell')); }, cancel() { htmlCancelled = true; } });
  const flight = new ReadableStream<Uint8Array>({ cancel() { flightCancelled = true; } });
  const reader = injectFlight(html, flight).getReader();
  await reader.read();
  const pending = reader.read();
  await pause();
  await reader.cancel('disconnect');
  await pending;
  expect(htmlCancelled).toBe(true);
  expect(flightCancelled).toBe(true);
});

test('abort signal cancels both producers and rejects an outstanding read', async () => {
  const abort = new AbortController();
  let cancelled = 0;
  const input = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const reader = injectFlight(input(), input(), { signal: abort.signal }).getReader();
  const pending = reader.read();
  abort.abort(new Error('gone'));
  await expect(pending).rejects.toThrow('gone');
  expect(cancelled).toBe(2);
});

test('Flight byte limit applies before tee even when hydration never consumes', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  const [render, hydration] = limitFlight(source, { maxBytes: 4096 }).tee();
  const drain = async (input: ReadableStream<Uint8Array>) => { const reader = input.getReader(); while (!(await reader.read()).done) { /* consume */ } };
  await expect(drain(render)).rejects.toThrow('Flight payload exceeds 4096 bytes');
  await expect(drain(hydration)).rejects.toThrow('Flight payload exceeds 4096 bytes');
  expect(cancelled).toBe(true);
});

test('fails boundedly on excessive unterminated HTML without draining input', async () => {
  const html = stream([bytes('<html><body><script>' + 'x'.repeat(2048))]);
  await expect(collect(injectFlight(html, stream([]), { maxPendingHtmlBytes: 1024 }))).rejects.toThrow('Pending HTML exceeds 1024 bytes');
});

test('a producer failure cancels its peer and survives cleanup failure', async () => {
  let cancelled = false;
  const html = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; throw new Error('cleanup failure'); } });
  const flight = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('original failure')); } });
  await expect(collect(injectFlight(html, flight))).rejects.toThrow('original failure');
  expect(cancelled).toBe(true);
});

test('random chunk boundaries preserve bytes and executable Flight placement', async () => {
  const original = '<html><head><script>self.a="<tag>"</script></head><body><template><style>a{}</style></template><svg><foreignObject><div>x</div></foreignObject></svg><p title="&quot;">🦀</p></body></html>';
  const source = bytes(original);
  let seed = 42;
  for (let trial = 0; trial < 100; trial++) {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < source.length;) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const length = 1 + seed % 31;
      chunks.push(source.slice(offset, offset + length));
      offset += length;
    }
    const result = scripts(await collect(injectFlight(stream(chunks), stream([bytes('first'), bytes('second')]))));
    expect(result.withoutFlight).toBe(original);
    expect(result.payload.toString()).toBe('firstsecond');
  }
});
