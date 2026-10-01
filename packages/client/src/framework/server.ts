import { AsyncLocalStorage } from 'node:async_hooks';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CacheEntry = { value: JsonValue; expiresAt: number };
/** Implementations must atomically reject writes after any supplied tag version changes. */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  versions(tags: string[]): Promise<Record<string, string>>;
  set(key: string, entry: CacheEntry, versions: Record<string, string>): Promise<boolean>;
  invalidate(tags: string[]): Promise<void>;
}
export interface RuntimeConfig {
  cache?: CacheStore;
  /** Include the deployment/build version to keep incompatible cached values apart. */
  cacheNamespace?: string;
  authorizeAction?: (request: Request) => void | Promise<void>;
}
export interface CookieOptions {
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
  expires?: Date;
}
type MemoNode = { children: Map<unknown, MemoNode>; result?: Promise<unknown> };
const negativeZero = Symbol('negative zero');
type State = {
  request: Request;
  mode: 'render' | 'action' | 'route';
  prerender: boolean;
  cookiesSealed: boolean;
  publicCache: boolean;
  cookies: string[];
  values: Map<string, string>;
  memo: Map<object, MemoNode>;
  config: RuntimeConfig;
};
const storage = new AsyncLocalStorage<State>();
function state(): State {
  const value = storage.getStore();
  if (!value) throw new Error('Zap server APIs require an active request.');
  return value;
}
function parseCookies(value: string | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (value ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (result.has(name)) continue;
    const raw = part.slice(separator + 1).trim();
    try { result.set(name, decodeURIComponent(raw)); }
    catch { result.set(name, raw); }
  }
  return result;
}
export async function handleRequest(
  incoming: Request,
  handler: () => Response | Promise<Response>,
  options: { mode: State['mode']; prerender?: boolean },
  config: RuntimeConfig = {},
): Promise<Response> {
  if (config.cache && !config.cacheNamespace) throw new Error('A shared cache requires cacheNamespace including the deployment version.');
  const scope: State = { request: incoming, mode: options.mode, prerender: options.prerender ?? false, cookiesSealed: false, publicCache: false, cookies: [], values: parseCookies(incoming.headers.get('cookie')), memo: new Map(), config };
  return storage.run(scope, async () => {
    incoming.signal.throwIfAborted();
    const response = await handler();
    scope.cookiesSealed = true;
    if (!scope.cookies.length) return response;
    const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const cookie of scope.cookies) result.headers.append('set-cookie', cookie);
    result.headers.set('cache-control', 'private, no-store');
    return result;
  });
}
function requestState(): State {
  const scope = state();
  if (scope.publicCache) throw new Error('Request metadata is unavailable inside a shared public cache loader. Use request-local memoize for personalized data.');
  if (scope.prerender) throw new Error('Request metadata cannot be accessed while prerendering. Remove prerender=true for personalized pages.');
  return scope;
}
export function request(): Request { return requestState().request; }
/** A copy prevents request metadata from being mutated during concurrent rendering. */
export function headers(): Headers { return new Headers(requestState().request.headers); }
export function cookies() {
  const scope = requestState();
  return {
    get: (name: string): string | undefined => scope.values.get(name),
    getAll: (): { name: string; value: string }[] => Array.from(scope.values, ([name, value]) => ({ name, value })),
    set(name: string, value: string, options: CookieOptions = {}): void {
      if (scope.cookiesSealed) throw new Error('Cookies cannot be modified after rendering or response streaming begins.');
      if (scope.mode === 'render') throw new Error('Cookies can only be modified in a server action or route handler.');
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('Invalid cookie name.');
      if (options.sameSite === 'none' && !options.secure) throw new Error('SameSite=None requires Secure.');
      if (name.startsWith('__Secure-') && !options.secure) throw new Error('__Secure- cookies require Secure.');
      if (name.startsWith('__Host-') && (!options.secure || options.domain || (options.path ?? '/') !== '/')) throw new Error('__Host- cookies require Secure, Path=/, and no Domain.');
      const parts = [`${name}=${encodeURIComponent(value)}`];
      const path = options.path ?? '/';
      if (/[;\r\n\x00-\x1f\x7f]/.test(path) || !path.startsWith('/')) throw new Error('Invalid cookie path.');
      parts.push(`Path=${path}`);
      if (options.domain) {
        if (!/^\.?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(options.domain)) throw new Error('Invalid cookie domain.');
        parts.push(`Domain=${options.domain}`);
      }
      if (options.maxAge !== undefined) {
        if (!Number.isSafeInteger(options.maxAge)) throw new Error('Cookie maxAge must be an integer.');
        parts.push(`Max-Age=${options.maxAge}`);
      }
      if (options.expires) {
        if (!Number.isFinite(options.expires.getTime())) throw new Error('Invalid cookie expiry.');
        parts.push(`Expires=${options.expires.toUTCString()}`);
      }
      if (options.httpOnly) parts.push('HttpOnly');
      if (options.secure) parts.push('Secure');
      parts.push(`SameSite=${options.sameSite ?? 'lax'}`);
      scope.cookies.push(parts.join('; '));
      if (options.maxAge !== undefined && options.maxAge <= 0) scope.values.delete(name);
      else scope.values.set(name, value);
    },
    delete(name: string, options: CookieOptions = {}): void {
      this.set(name, '', { ...options, maxAge: 0, expires: new Date(0) });
    },
  };
}
/** @internal End mutation privileges before React renders or response streaming starts. */
export function sealCookies(): void { state().cookiesSealed = true; }
export async function authorizeAction(): Promise<void> {
  const scope = state();
  await scope.config.authorizeAction?.(scope.request);
}
/** Deduplicate per request using argument identity, or an explicit application key. */
export function memoize<A extends unknown[], T>(loader: (...args: A) => Promise<T>, key?: (...args: A) => string) {
  const identity = {};
  return (...args: A): Promise<T> => {
    const scope = state();
    let node: MemoNode = scope.memo.get(identity) ?? { children: new Map() };
    scope.memo.set(identity, node);
    for (const value of key ? [key(...args)] : args) {
      const argument = Object.is(value, -0) ? negativeZero : value;
      let child: MemoNode | undefined = node.children.get(argument);
      if (!child) node.children.set(argument, child = { children: new Map() });
      node = child;
    }
    node.result ??= Promise.resolve().then(() => loader(...args));
    return node.result as Promise<T>;
  };
}
/** Shared public data only. Personalized data belongs in request-local memoize. */
export function cache<A extends unknown[], T extends JsonValue>(loader: (...args: A) => Promise<T>, options: {
  key: (...args: A) => string;
  ttl: number;
  tags?: (...args: A) => string[];
}) {
  if (!Number.isFinite(options.ttl) || options.ttl <= 0) throw new Error('Cache ttl must be positive seconds.');
  return memoize(async (...args: A): Promise<T> => {
    const { cache: store, cacheNamespace } = state().config;
    if (!store || !cacheNamespace) throw new Error('Shared caching requires a configured CacheStore and deployment cacheNamespace.');
    const prefix = JSON.stringify(cacheNamespace);
    const key = `${prefix}:${options.key(...args)}`;
    const tags = [...new Set(options.tags?.(...args) ?? [])].map(tag => `${prefix}:${tag}`);
    const hit = await store.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const versions = await store.versions(tags);
    const value = await storage.run({ ...state(), publicCache: true, cookiesSealed: true, memo: new Map() }, () => loader(...args));
    await store.set(key, { value, expiresAt: Date.now() + options.ttl * 1000 }, versions);
    return value;
  }, options.key);
}
export async function revalidateTag(tag: string): Promise<void> {
  const scope = state();
  if (scope.mode === 'render') throw new Error('Cache invalidation requires a server action or route handler.');
  const { cache: store, cacheNamespace } = scope.config;
  if (!store || !cacheNamespace) throw new Error('Cache invalidation requires a configured CacheStore.');
  await store.invalidate([`${JSON.stringify(cacheNamespace)}:${tag}`]);
  scope.memo.clear();
}
