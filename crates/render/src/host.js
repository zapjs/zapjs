globalThis.self = globalThis;
const zapConsole = Object.freeze({
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  assert(condition, ...args) { if (!condition) this.error(...args); }
});
globalThis.console = zapConsole;
globalThis.queueMicrotask = fn => Promise.resolve().then(fn);

const postedMessages = [];
class MessageEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.data = init.data;
    this.target = init.target ?? null;
    this.currentTarget = this.target;
  }
}
class MessagePort {
  #peer = null;
  #closed = false;
  #listeners = new Set();
  onmessage = null;
  onmessageerror = null;
  postMessage(data) {
    if (this.#closed || !this.#peer || this.#peer.#closed) return;
    postedMessages.push({port: this.#peer, data});
  }
  start() {}
  close() { this.#closed = true; }
  addEventListener(type, listener) {
    if (type === 'message' && typeof listener === 'function') this.#listeners.add(listener);
  }
  removeEventListener(type, listener) {
    if (type === 'message') this.#listeners.delete(listener);
  }
  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    if (event.type === 'message' && typeof this.onmessage === 'function') this.onmessage(event);
    if (event.type === 'message') for (const listener of [...this.#listeners]) listener.call(this, event);
    return true;
  }
  _zapEntangle(peer) { this.#peer = peer; }
}
class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._zapEntangle(this.port2);
    this.port2._zapEntangle(this.port1);
  }
}
globalThis.MessageEvent = MessageEvent;
globalThis.MessagePort = MessagePort;
globalThis.MessageChannel = MessageChannel;
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
  for (let i = 0; i < 256 && postedMessages.length > 0; i++) {
    const message = postedMessages.shift();
    message.port.dispatchEvent(new MessageEvent('message', {data: message.data, target: message.port}));
  }
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

class URLSearchParams {
  #values = [];
  constructor(init = '') {
    if (init instanceof URLSearchParams) {
      for (const [name, value] of init) this.append(name, value);
    } else if (typeof init === 'string') {
      const input = init.startsWith('?') ? init.slice(1) : init;
      if (input.length > 0) {
        for (const part of input.split('&')) {
          if (part.length === 0) continue;
          const index = part.indexOf('=');
          const name = index < 0 ? part : part.slice(0, index);
          const value = index < 0 ? '' : part.slice(index + 1);
          this.append(decodeFormComponent(name), decodeFormComponent(value));
        }
      }
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('URLSearchParams pair must be [name, value]');
        this.append(pair[0], pair[1]);
      }
    } else if (init && typeof init === 'object') {
      for (const name of Object.keys(init)) {
        const value = init[name];
        if (Array.isArray(value)) for (const item of value) this.append(name, item);
        else this.append(name, value);
      }
    }
  }
  append(name, value) { this.#values.push([String(name), String(value)]); }
  set(name, value) {
    name = String(name);
    this.delete(name);
    this.append(name, value);
  }
  get(name) {
    name = String(name);
    const pair = this.#values.find(([key]) => key === name);
    return pair ? pair[1] : null;
  }
  getAll(name) {
    name = String(name);
    return this.#values.filter(([key]) => key === name).map(([, value]) => value);
  }
  has(name) {
    name = String(name);
    return this.#values.some(([key]) => key === name);
  }
  delete(name) {
    name = String(name);
    this.#values = this.#values.filter(([key]) => key !== name);
  }
  *entries() { for (const pair of this.#values) yield pair; }
  [Symbol.iterator]() { return this.entries(); }
  toString() {
    return this.#values
      .map(([name, value]) => `${encodeFormComponent(name)}=${encodeFormComponent(value)}`)
      .join('&');
  }
}

function decodeFormComponent(value) {
  return decodeURIComponent(String(value).replace(/\+/g, ' '));
}

function encodeFormComponent(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

class URL {
  constructor(input, base = undefined) {
    const parsed = parseUrl(String(input), base === undefined ? undefined : String(base));
    this.protocol = parsed.protocol;
    this.hostname = parsed.hostname;
    this.port = parsed.port;
    this.pathname = parsed.pathname;
    this.hash = parsed.hash;
    this.searchParams = new URLSearchParams(parsed.search);
    this.#sync();
  }
  #sync() {
    const authority = this.port ? `${this.hostname}:${this.port}` : this.hostname;
    this.origin = `${this.protocol}//${authority}`;
    const query = this.searchParams.toString();
    this.search = query ? `?${query}` : '';
    this.href = `${this.origin}${this.pathname}${this.search}${this.hash}`;
  }
  toString() { this.#sync(); return this.href; }
  toJSON() { return this.toString(); }
}

function parseUrl(input, base) {
  let value = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    if (base === undefined) throw new TypeError('Invalid URL');
    const parsedBase = parseUrl(base);
    if (value.startsWith('/')) {
      value = `${parsedBase.protocol}//${parsedBase.hostname}${parsedBase.port ? `:${parsedBase.port}` : ''}${value}`;
    } else {
      const directory = parsedBase.pathname.endsWith('/')
        ? parsedBase.pathname
        : parsedBase.pathname.slice(0, parsedBase.pathname.lastIndexOf('/') + 1);
      value = `${parsedBase.protocol}//${parsedBase.hostname}${parsedBase.port ? `:${parsedBase.port}` : ''}${directory}${value}`;
    }
  }
  const match = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) throw new TypeError('Invalid URL');
  const protocol = match[1];
  const authority = match[2];
  const slash = authority.lastIndexOf(':');
  const hostname = slash >= 0 ? authority.slice(0, slash) : authority;
  const port = slash >= 0 ? authority.slice(slash + 1) : '';
  if (!hostname) throw new TypeError('Invalid URL');
  return {
    protocol,
    hostname,
    port,
    pathname: match[3] || '/',
    search: match[4] || '',
    hash: match[5] || ''
  };
}

globalThis.URLSearchParams = URLSearchParams;
globalThis.URL = URL;

class Request {
  constructor(input, init = {}) {
    if (input instanceof Request) {
      this.url = input.url;
      this.method = init.method == null ? input.method : String(init.method).toUpperCase();
      this.headers = new Headers(init.headers == null ? input.headers : init.headers);
      this.body = init.body == null ? input.body : normalizeBody(init.body);
    } else {
      this.url = String(input);
      this.method = init.method == null ? 'GET' : String(init.method).toUpperCase();
      this.headers = new Headers(init.headers);
      this.body = init.body == null ? '' : normalizeBody(init.body);
    }
    this.bodyUsed = false;
  }
  clone() {
    if (this.bodyUsed) throw new TypeError('Cannot clone a used Request body');
    const copy = new Request(this.url, {method: this.method, headers: this.headers, body: this.body});
    for (const key of Object.keys(this)) {
      if (!(key in copy)) copy[key] = this[key];
    }
    return copy;
  }
  async text() {
    return bodyText(consumeBody(this));
  }
  async json() {
    return JSON.parse(await this.text());
  }
  async arrayBuffer() {
    const bytes = new TextEncoder().encode(await this.text());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function consumeBody(request) {
  if (request.bodyUsed) throw new TypeError('Request body has already been read');
  request.bodyUsed = true;
  return request.body;
}

function normalizeBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  return String(body);
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body == null) return '';
  return String(body);
}

globalThis.Request = Request;

class Response {
  constructor(body = '', init = {}) {
    this.status = init.status == null ? 200 : Number(init.status);
    if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599) throw new RangeError('Invalid response status');
    this.statusText = init.statusText == null ? '' : String(init.statusText);
    this.headers = new Headers(init.headers);
    this.body = normalizeBody(body);
    this.bodyUsed = false;
  }
  static json(value, init = {}) {
    const response = new Response(JSON.stringify(value), init);
    if (!response.headers.has('content-type')) response.headers.set('content-type', 'application/json');
    return response;
  }
  static redirect(url, status = 302) {
    status = Number(status);
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status');
    return new Response('', {status, headers: {location: String(url)}});
  }
  clone() {
    if (this.bodyUsed) throw new TypeError('Cannot clone a used Response body');
    return new Response(this.body, {status: this.status, statusText: this.statusText, headers: this.headers});
  }
  async text() {
    return bodyText(consumeResponseBody(this));
  }
  async json() {
    return JSON.parse(await this.text());
  }
  async arrayBuffer() {
    const bytes = new TextEncoder().encode(await this.text());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function consumeResponseBody(response) {
  if (response.bodyUsed) throw new TypeError('Response body has already been read');
  response.bodyUsed = true;
  return response.body;
}

globalThis.Response = Response;

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
