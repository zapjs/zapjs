globalThis.self = globalThis;
globalThis.queueMicrotask = fn => Promise.resolve().then(fn);
let nextTimer = 1;
const timers = new Map();
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  if (typeof fn !== 'function') throw new TypeError('Timer callback must be a function');
  const id = nextTimer++;
  timers.set(id, {at: __zap_now() + Math.max(0, Number(delay) || 0), fn: () => fn(...args)});
  return id;
};
globalThis.clearTimeout = id => timers.delete(id);
globalThis.__zap_pump = () => {
  const now = __zap_now();
  const ready = [...timers].filter(([, timer]) => timer.at <= now);
  for (const [id, timer] of ready) if (timers.delete(id)) timer.fn();
};
globalThis.performance = {now: __zap_now};
globalThis.TextEncoder = class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(text = '') { return __zap_encode(String(text)); }
  encodeInto(text, destination) {
    if (!(destination instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
    let read = 0, written = 0;
    for (const point of String(text)) {
      const bytes = this.encode(point);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written); written += bytes.length; read += point.length;
    }
    return {read, written};
  }
};
globalThis.TextDecoder = class TextDecoder {
  #id;
  constructor(label = 'utf-8', options = {}) {
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(String(label).toLowerCase().trim())) {
      throw new RangeError('The renderer supports UTF-8 text decoding');
    }
    this.fatal = !!options.fatal;
    this.ignoreBOM = !!options.ignoreBOM;
    this.#id = __zap_decoder(this.ignoreBOM);
  }
  get encoding() { return 'utf-8'; }
  decode(input = new Uint8Array(), options = {}) {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    return __zap_decode(this.#id, bytes, !!options.stream, this.fatal);
  }
};
globalThis.__zap_consume = async result => {
  result = await result;
  if (typeof result === 'string') { __zap_emit(new TextEncoder().encode(result)); return; }
  if (!result || typeof result.getReader !== 'function') throw new TypeError('ZapRender.render must return text or a ReadableStream');
  const reader = result.getReader();
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Render streams must contain Uint8Array chunks');
      __zap_emit(value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
};
