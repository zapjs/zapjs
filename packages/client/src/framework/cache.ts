import type { CacheEntry, CacheStore } from './server.js';

const read = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local entry = cjson.decode(raw)
for key, version in pairs(entry.versions) do
  if (redis.call('GET', key) or '0') ~= version then return false end
end
return entry.data
`;
const write = `
local versions = cjson.decode(ARGV[2])
for key, version in pairs(versions) do
  if (redis.call('GET', key) or '0') ~= version then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1
`;
const invalidate = `
for _, key in ipairs(KEYS) do redis.call('INCR', key) end
return 1
`;
function validateValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Shared cache values must be JSON primitives, arrays, or plain objects without cycles.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Shared cache values must be JSON primitives, arrays, or plain objects.');
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) validateValue(entry, ancestors);
  ancestors.delete(value);
}
export type RedisCommand = (command: (string | number)[]) => Promise<unknown>;
/** Atomic tag invalidation across function instances, including in-flight cache fills. */
export function createRedisCache(execute: RedisCommand, prefix = 'zap'): CacheStore {
  const item = (key: string) => `${prefix}:value:${key}`;
  const tag = (key: string) => `${prefix}:tag:${key}`;
  return {
    async get(key) {
      const value = await execute(['EVAL', read, 1, item(key)]);
      if (value === null || value === false) return undefined;
      if (typeof value !== 'string') throw new Error('Invalid Redis cache response.');
      const entry = JSON.parse(value) as CacheEntry;
      if (typeof entry.expiresAt !== 'number') throw new Error('Invalid Redis cache entry.');
      return entry;
    },
    async versions(tags) {
      if (!tags.length) return {};
      const result = await execute(['MGET', ...tags.map(tag)]);
      if (!Array.isArray(result) || result.length !== tags.length) throw new Error('Invalid Redis tag versions.');
      return Object.fromEntries(tags.map((key, index) => [tag(key), result[index] === null ? '0' : String(result[index])]));
    },
    async set(key, data, versions) {
      const ttl = Math.ceil(data.expiresAt - Date.now());
      if (ttl <= 0) return false;
      validateValue(data.value);
      const encoded = JSON.stringify(data);
      const payload = JSON.stringify({ data: encoded, versions });
      if (!Object.hasOwn(JSON.parse(encoded), 'value')) throw new Error('Shared cache values must be JSON serializable.');
      return await execute(['EVAL', write, 1, item(key), payload, JSON.stringify(versions), ttl]) === 1;
    },
    async invalidate(tags) {
      if (tags.length) await execute(['EVAL', invalidate, tags.length, ...tags.map(tag)]);
    },
  };
}
/** Redis REST command protocol supported by managed Upstash Redis. */
export function createRedisRestCache(options: { url: string; token: string; prefix?: string; timeout?: number }): CacheStore {
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'https:') throw new Error('Managed Redis REST requires HTTPS.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Redis credentials belong in the token option.');
  if (!options.token) throw new Error('Redis REST token is required.');
  const timeout = options.timeout ?? 5000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Redis timeout must be positive milliseconds.');
  return createRedisCache(async command => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Redis REST request failed (${response.status}).`);
    const body = await response.json() as { result?: unknown; error?: string };
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Redis REST command failed.');
    return body.result;
  }, options.prefix);
}
