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

class Headers {
  #values = [];
  constructor(init = undefined) {
    if (init instanceof Headers) {
      for (const [name, value] of init) this.append(name, value);
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Header pair must be [name, value]');
        this.append(pair[0], pair[1]);
      }
    } else if (init && typeof init === 'object') {
      for (const name of Object.keys(init)) this.append(name, init[name]);
    }
  }
  append(name, value) { this.#values.push([normalizeHeaderName(name), String(value)]); }
  set(name, value) {
    name = normalizeHeaderName(name);
    this.#values = this.#values.filter(([key]) => key !== name);
    this.#values.push([name, String(value)]);
  }
  get(name) {
    name = normalizeHeaderName(name);
    const values = this.#values.filter(([key]) => key === name).map(([, value]) => value);
    return values.length ? values.join(', ') : null;
  }
  has(name) { return this.get(name) !== null; }
  delete(name) {
    name = normalizeHeaderName(name);
    this.#values = this.#values.filter(([key]) => key !== name);
  }
  *entries() { for (const pair of this.#values) yield pair; }
  [Symbol.iterator]() { return this.entries(); }
}
function normalizeHeaderName(name) {
  name = String(name).toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new TypeError('Invalid header name');
  return name;
}
globalThis.Headers = Headers;

globalThis.Response = class Response {
  constructor(body = '', init = {}) {
    this.status = init.status == null ? 200 : Number(init.status);
    if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599) throw new RangeError('Invalid response status');
    this.statusText = init.statusText == null ? '' : String(init.statusText);
    this.headers = new Headers(init.headers);
    this.body = body;
  }
  static json(value, init = {}) {
    const response = new Response(JSON.stringify(value), init);
    if (!response.headers.has('content-type')) response.headers.set('content-type', 'application/json');
    return response;
  }
  async text() {
    if (typeof this.body === 'string') return this.body;
    if (this.body == null) return '';
    if (this.body instanceof Uint8Array) return new TextDecoder().decode(this.body);
    return String(this.body);
  }
};

globalThis.__zap_consume = async result => {
  result = await result;
  if (result instanceof Response) result = result.body;
  if (typeof result === 'string') { __zap_emit(new TextEncoder().encode(result)); return; }
  if (result instanceof Uint8Array) { __zap_emit(result); return; }
  if (!result || typeof result.getReader !== 'function') throw new TypeError('Zap entrypoint must return text, a Response, Uint8Array, or a ReadableStream');
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

globalThis.__zap_entry_response = async result => {
  result = await result;
  if (result instanceof Response) {
    await __zap_consume(result.body);
    return JSON.stringify({status: result.status, headers: [...result.headers]});
  }
  await __zap_consume(result);
  return JSON.stringify({status: 200, headers: []});
};
