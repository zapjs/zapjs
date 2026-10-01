import { beforeAll, afterAll, test, expect } from 'bun:test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRedisCache, createRedisRestCache, type RedisCommand } from './cache.js';
const exec = promisify(execFile);
let root: string;
let process: ChildProcess;
let command: RedisCommand;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'zap-cache-'));
  const socket = join(root, 'redis.sock');
  process = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  let failure: Error | undefined;
  process.on('error', error => { failure = error; });
  command = async args => {
    const result = await exec('redis-cli', ['--json', '-s', socket, ...args.map(String)], { timeout: 5000 });
    const value = JSON.parse(result.stdout);
    if (typeof value === 'object' && value !== null && 'error' in value) throw new Error(value.error);
    return value;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    try { if (await command(['PING']) === 'PONG') return; } catch { /* Redis has not bound its test socket yet. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Redis did not start for cache integration tests.');
});
afterAll(async () => {
  if (process && process.exitCode === null) {
    await new Promise<void>(resolve => { process.once('exit', () => resolve()); process.kill('SIGTERM'); });
  }
  if (root) await rm(root, { recursive: true, force: true });
});
test('Redis shares entries across instances and atomically invalidates pending writes', async () => {
  const a = createRedisCache(command, 'integration');
  const b = createRedisCache(command, 'integration');
  const original = await a.versions(['products']);
  expect(await a.set('p:1', { value: { price: 10 }, expiresAt: Date.now() + 10000 }, original)).toBe(true);
  expect((await b.get('p:1'))?.value).toEqual({ price: 10 });
  await b.invalidate(['products']);
  expect(await a.get('p:1')).toBeUndefined();
  expect(await a.set('p:2', { value: 'stale', expiresAt: Date.now() + 10000 }, original)).toBe(false);
  expect(await b.get('p:2')).toBeUndefined();
  expect(await b.set('p:2', { value: 'fresh', expiresAt: Date.now() + 10000 }, await b.versions(['products']))).toBe(true);
  expect((await a.get('p:2'))?.value).toBe('fresh');
});
test('Redis expires entries and preserves falsy values', async () => {
  const store = createRedisCache(command, 'expiry');
  for (const value of [false, 0, '', null, [], {}]) {
    expect(await store.set('item', { value, expiresAt: Date.now() + 10000 }, {})).toBe(true);
    expect((await store.get('item'))?.value).toEqual(value);
  }
  await store.set('short', { value: 1, expiresAt: Date.now() + 30 }, {});
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(await store.get('short')).toBeUndefined();
  for (const value of [undefined, new Date(), NaN, Infinity, { missing: undefined }]) {
    await expect(store.set('bad', { value: value as never, expiresAt: Date.now() + 1000 }, {})).rejects.toThrow('JSON');
  }
});
test('REST cache fails fast on unsafe endpoint configuration', () => {
  expect(() => createRedisRestCache({ url: 'http://redis.test', token: 'secret' })).toThrow('HTTPS');
  expect(() => createRedisRestCache({ url: 'https://redis.test?token=secret', token: 'secret' })).toThrow('credentials');
});
