import { SAXParser } from 'parse5-sax-parser';

/** Bounds the hydration branch of the RSC tee, including before HTML can render. */
export const MAX_FLIGHT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_HTML_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export function limitFlight(source: ReadableStream<Uint8Array>, options: { signal?: AbortSignal; maxBytes?: number } = {}): ReadableStream<Uint8Array> {
  const maximum = options.maxBytes ?? MAX_FLIGHT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError('Invalid Flight byte limit');
  const reader = source.getReader();
  let total = 0, finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => options.signal?.removeEventListener('abort', abort);
  const stop = (reason: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    controller.error(reason);
    // Preserve the original stream failure; producer cleanup can reject after
    // an upstream error and must not become an unhandled secondary rejection.
    void Promise.allSettled([reader.cancel(reason)]);
  };
  const abort = () => stop(options.signal!.reason ?? new Error('Request aborted'));
  return new ReadableStream({
    start(value) { controller = value; options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort(); },
    async pull() {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) { finished = true; cleanup(); controller.close(); return; }
        total += chunk.value.byteLength;
        if (total > maximum) { stop(new Error(`Flight payload exceeds ${maximum} bytes`)); return; }
        controller.enqueue(chunk.value);
      } catch (error) { stop(error); }
    },
    async cancel(reason) { if (!finished) { finished = true; cleanup(); await reader.cancel(reason); } },
  }, { highWaterMark: 0 });
}

/** Serialize each chunk independently: split UTF-8 and binary Flight records stay byte-exact. */
function flightScript(chunk: Uint8Array): Uint8Array {
  let expression: string;
  try {
    // Do not carry decoder state across binary records. An incomplete sequence is
    // encoded as bytes; the browser's Flight decoder reconstructs the stream.
    expression = JSON.stringify(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chunk));
  } catch {
    expression = `Uint8Array.from(atob(${JSON.stringify(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'))}),c=>c.charCodeAt(0))`;
  }
  // Escape all '<' characters so neither HTML script termination nor comment
  // syntax can be introduced by application strings. Preserve the JS value.
  expression = expression.replace(/</g, '\\u003c');
  return encoder.encode(`<script>(self.__FLIGHT_DATA||=[]).push(${expression})</script>`);
}

type LocatedToken = { sourceCodeLocation?: { startOffset: number; endOffset: number } | null };
type TagToken = LocatedToken & { tagName: string; selfClosing?: boolean };
const protectedTags = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'template', 'svg', 'math']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Merge HTML and Flight only at complete HTML token boundaries. Reads are driven
 * by output demand; at most one pending read from each input is retained. React
 * still owns rendering/decoding. parse5 owns tokenization, including raw text.
 */
export function injectFlight(html: ReadableStream<Uint8Array>, flight: ReadableStream<Uint8Array>, options: { signal?: AbortSignal; maxPendingHtmlBytes?: number } = {}): ReadableStream<Uint8Array> {
  const maximum = options.maxPendingHtmlBytes ?? MAX_PENDING_HTML_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError('Invalid HTML byte limit');
  const htmlReader = html.getReader(), flightReader = flight.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parser = new SAXParser({ sourceCodeLocationInfo: true });
  let buffer = '', baseOffset = 0, safeOffset = 0;
  let active = false, bodyEnded = false, boundaryEmitted = false;
  const protectedStack: string[] = [];
  const elements: string[] = [];
  const safe = (offset: number | undefined) => {
    // Keep transport scripts outside application elements: inserting a script
    // into a partially emitted text node can change React hydration semantics.
    if (offset !== undefined && active && !bodyEnded && protectedStack.length === 0 && ['head', 'body'].includes(elements.at(-1) || '')) safeOffset = offset;
  };
  parser.on('startTag', (token: TagToken) => {
    if (protectedStack.length === 0 && (token.tagName === 'head' || token.tagName === 'body')) active = true;
    const foreign = protectedStack.includes('svg') || protectedStack.includes('math') || token.tagName === 'svg' || token.tagName === 'math';
    if (!(token.selfClosing && foreign) && (foreign || !voidTags.has(token.tagName))) elements.push(token.tagName);
    if (protectedTags.has(token.tagName)) {
      // HTML ignores '/>' on raw-text/template tags; foreign tags may self-close.
      if (!token.selfClosing || !foreign) protectedStack.push(token.tagName);
    }
    safe(token.sourceCodeLocation?.endOffset);
  });
  parser.on('endTag', (token: TagToken) => {
    if (protectedStack.at(-1) === token.tagName) protectedStack.pop();
    if (protectedStack.length === 0 && token.tagName === 'body') {
      safe(token.sourceCodeLocation?.startOffset);
      bodyEnded = true;
      active = false;
    } else if (protectedStack.length === 0 && token.tagName === 'head') {
      safe(token.sourceCodeLocation?.startOffset);
      active = false;
    }
    const index = elements.lastIndexOf(token.tagName);
    if (index >= 0) elements.length = index;
    if (token.tagName !== 'head' && token.tagName !== 'body') safe(token.sourceCodeLocation?.endOffset);
  });
  let htmlDone = false, flightDone = false, stopped = false;
  let nextHtml: Uint8Array | undefined, nextFlight: Uint8Array | undefined;
  let pendingHtml: Promise<void> | undefined, pendingFlight: Promise<void> | undefined;
  let failure: unknown, failed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { options.signal?.removeEventListener('abort', abort); parser.destroy(); };
  const cancelInputs = async (reason: unknown) => {
    // Both cancellations are attempted even when one producer rejects cleanup.
    // The original abort/stream failure remains the consumer-visible reason.
    await Promise.allSettled([htmlReader.cancel(reason), flightReader.cancel(reason)]);
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    controller.error(error);
    void cancelInputs(error);
  };
  const abort = () => fail(options.signal!.reason ?? new Error('Request aborted'));
  const rememberFailure = (error: unknown) => { failure = error; failed = true; };
  parser.on('error', rememberFailure);
  const append = (text: string, last = false) => {
    buffer += text;
    if (Buffer.byteLength(buffer) > maximum) throw new Error(`Pending HTML exceeds ${maximum} bytes`);
    if (last) parser.end(text); else parser.write(text);
  };
  const readHtml = () => {
    if (htmlDone || pendingHtml || nextHtml) return;
    pendingHtml = htmlReader.read().then(chunk => {
      if (stopped) return;
      if (chunk.done) { htmlDone = true; append(decoder.decode(), true); }
      else nextHtml = chunk.value;
    }).catch(rememberFailure).finally(() => { pendingHtml = undefined; });
  };
  const readFlight = () => {
    if (flightDone || pendingFlight || nextFlight) return;
    pendingFlight = flightReader.read().then(chunk => {
      if (stopped) return;
      if (chunk.done) flightDone = true;
      else nextFlight = chunk.value;
    }).catch(rememberFailure).finally(() => { pendingFlight = undefined; });
  };
  return new ReadableStream({
    start(value) { controller = value; options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort(); },
    async pull() {
      try {
        while (!stopped) {
          if (failed) throw failure;
          if (boundaryEmitted && nextFlight) {
            const chunk = nextFlight;
            nextFlight = undefined;
            controller.enqueue(flightScript(chunk));
            return;
          }
          if (safeOffset > baseOffset) {
            const length = safeOffset - baseOffset;
            const text = buffer.slice(0, length);
            buffer = buffer.slice(length);
            baseOffset = safeOffset;
            boundaryEmitted = true;
            controller.enqueue(encoder.encode(text));
            return;
          }
          if (nextHtml) {
            const chunk = nextHtml;
            nextHtml = undefined;
            append(decoder.decode(chunk, { stream: true }));
            continue;
          }
          if (htmlDone && flightDone) {
            if (protectedStack.length) throw new Error('HTML ended inside protected content');
            if (buffer) { controller.enqueue(encoder.encode(buffer)); buffer = ''; }
            stopped = true;
            cleanup();
            controller.close();
            return;
          }
          if (htmlDone && !boundaryEmitted) throw new Error('HTML has no safe document insertion boundary');
          readHtml();
          // Reading one Flight chunk early cannot deadlock SSR's tee consumer.
          // The limit applied before tee bounds all bytes retained by that tee.
          readFlight();
          const pending = [pendingHtml, pendingFlight].filter((value): value is Promise<void> => !!value);
          if (pending.length) await Promise.race(pending);
          else throw new Error('HTML/Flight stream made no progress');
        }
      } catch (error) { fail(error); }
    },
    async cancel(reason) { if (!stopped) { stopped = true; cleanup(); await cancelInputs(reason); } },
  }, { highWaterMark: 0 });
}
