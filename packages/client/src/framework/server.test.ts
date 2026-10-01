import { describe, test, expect } from 'bun:test';
import { handleRequest, request, headers, cookies, memoize, cache, revalidateTag, authorizeAction, type CacheStore, type CacheEntry } from './server.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('request scope', () => {
  test('isolates concurrent requests and deduplicates only within one request', async () => {
    let loads = 0;
    const load = memoize(async (key: string) => { loads++; await delay(5); return `${headers().get('user')}:${key}`; });
    const values = await Promise.all(['alice', 'bob'].map(user => handleRequest(new Request('https://zap.test', { headers: { user } }), async () => {
      const [first, second] = await Promise.all([load('profile'), load('profile')]);
      expect(first).toBe(second);
      headers().set('user', 'changed');
      expect(request().headers.get('user')).toBe(user);
      return new Response(first);
    }, { mode: 'render' }).then(r => r.text())));
    expect(values).toEqual(['alice:profile', 'bob:profile']);
    expect(loads).toBe(2);
    expect(() => request()).toThrow('active request');
  });
  test('keeps distinct cookies, enforces scope, and marks mutations private', async () => {
    const incoming = new Request('https://zap.test', { headers: { cookie: 'a=one%20two; malformed=%XX' } });
    await handleRequest(incoming, () => {
      expect(cookies().get('a')).toBe('one two');
      expect(cookies().get('malformed')).toBe('%XX');
      expect(() => cookies().set('a', 'bad')).toThrow('only');
      return new Response('render');
    }, { mode: 'render' });
    const result = await handleRequest(incoming, () => {
      cookies().set('session', 'abc', { httpOnly: true, secure: true });
      cookies().delete('a');
      expect(cookies().get('a')).toBeUndefined();
      expect(() => cookies().set('__Host-bad', 'x')).toThrow();
      expect(() => cookies().set('x', 'x', { path: '/;injected=true' })).toThrow();
      return new Response('ok', { headers: { 'cache-control': 'public, max-age=60' } });
    }, { mode: 'action' });
    expect(result.headers.getSetCookie()).toHaveLength(2);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  });
  test('authorization runs in request scope and failures propagate', async () => {
    await expect(handleRequest(new Request('https://zap.test'), async () => {
      await authorizeAction();
      return new Response('must not execute');
    }, { mode: 'action' }, { authorizeAction: () => { throw new Error('Denied mutation'); } })).rejects.toThrow('Denied mutation');
  });
});

// A contract test implementation models version changes; Redis integration verifies atomic storage separately.
function store(): CacheStore {
  const data = new Map<string, { entry: CacheEntry; versions: Record<string, string> }>();
  const tags = new Map<string, number>();
  const current = (name: string) => String(tags.get(name) ?? 0);
  return {
    async get(key) { const value = data.get(key); return value && Object.entries(value.versions).every(([k,v]) => current(k) === v) ? value.entry : undefined; },
    async versions(names) { return Object.fromEntries(names.map(name => [name, current(name)])); },
    async set(key, entry, versions) { if (!Object.entries(versions).every(([k,v]) => current(k) === v)) return false; data.set(key, { entry, versions }); return true; },
    async invalidate(names) { for (const name of names) tags.set(name, Number(current(name)) + 1); },
  };
}
test('shared cache namespaces deployments and invalidation rejects an in-flight stale fill', async () => {
  const backend = store();
  const config = { cache: backend, cacheNamespace: 'build-1' };
  const run = (fn: () => Promise<unknown>, override = config) => handleRequest(new Request('https://zap.test'), async () => Response.json(await fn()), { mode: 'route' }, override).then(r => r.json());
  let loads = 0;
  const load = cache(async () => ++loads, { key: () => 'item', ttl: 60, tags: () => ['products'] });
  expect(await run(load)).toBe(1);
  expect(await run(load)).toBe(1);
  await run(async () => { await revalidateTag('products'); return null; });
  expect(await run(load)).toBe(2);
  expect(await run(load, { ...config, cacheNamespace: 'build-2' })).toBe(3);
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = cache(async () => { started(); await gate; return 'stale'; }, { key: () => 'slow', ttl: 60, tags: () => ['products'] });
  const pending = run(slow);
  await began;
  await run(async () => { await revalidateTag('products'); return null; });
  release(); await pending;
  expect(await backend.get('"build-1":slow')).toBeUndefined();
});

test('streaming cannot mutate headers after the response has been returned', async () => {
  let write!: () => void;
  await handleRequest(new Request('https://zap.test'), () => {
    const jar = cookies();
    write = () => jar.set('late', 'value');
    return new Response('started');
  }, { mode: 'route' });
  expect(write).toThrow('streaming begins');
});

test('prerender rejects all request-dependent metadata', async () => {
  await handleRequest(new Request('https://zap.test'), () => {
    expect(() => request()).toThrow('prerendering');
    expect(() => headers()).toThrow('prerendering');
    expect(() => cookies()).toThrow('prerendering');
    return new Response('public');
  }, { mode: 'render', prerender: true });
});

test('shared cache loaders cannot read private request metadata', async () => {
  const config = { cache: store(), cacheNamespace: 'public' };
  const load = cache(async () => headers().get('authorization'), { key: () => 'constant', ttl: 60 });
  await expect(handleRequest(new Request('https://zap.test', { headers: { authorization: 'private' } }), async () => Response.json(await load()), { mode: 'render' }, config)).rejects.toThrow('shared public cache');
});

test('request memoization distinguishes null, undefined, identities and signed zero', async () => {
  let loads = 0;
  const load = memoize(async (_value: unknown) => ++loads);
  await handleRequest(new Request('https://zap.test'), async () => {
    const object = {};
    const values = await Promise.all([load(null), load(undefined), load(object), load(object), load({}), load(0), load(-0)]);
    expect(values).toEqual([1,2,3,3,4,5,6]);
    return new Response('ok');
  }, { mode: 'render' });
});
