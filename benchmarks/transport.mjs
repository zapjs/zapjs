#!/usr/bin/env node
/**
 * Isolated scheduler experiment, deliberately not part of the framework runtime.
 * The generated candidate is rsc-html-stream 0.0.8 (MIT, Devon Govett) with only
 * setTimeout/clearTimeout changed to setImmediate/clearImmediate. Its LICENSE is
 * copied alongside it. Neither source dependencies nor framework source change.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPath = fileURLToPath(import.meta.resolve('rsc-html-stream/server'));
const packageJson = JSON.parse(await readFile(join(dirname(upstreamPath), 'package.json'), 'utf8'));
assert.equal(packageJson.version, '0.0.8', 'Review this experiment against any dependency upgrade');
const source = await readFile(upstreamPath, 'utf8');
assert.equal(source.match(/timeout = setTimeout\(/g)?.length, 1);
assert.equal(source.match(/clearTimeout\(timeout\)/g)?.length, 1);
const candidate = source.replace('timeout = setTimeout(', 'timeout = setImmediate(').replace('clearTimeout(timeout)', 'clearImmediate(timeout)');
const directory = await mkdtemp(join(tmpdir(), 'zap-transport-experiment-'));
const candidatePath = join(directory, 'immediate.mjs');
await writeFile(candidatePath, candidate);
await copyFile(join(dirname(upstreamPath), 'LICENSE'), join(directory, 'LICENSE'));
const { injectRSCPayload: upstream } = await import(pathToFileURL(upstreamPath).href);
const { injectRSCPayload: immediate } = await import(pathToFileURL(candidatePath).href);
const encoder = new TextEncoder();
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = text => encoder.encode(text);
const stream = chunks => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
const collect = async stream => new Response(stream).text();
function flightBytes(html) {
  const sandbox = { self: {}, atob, Uint8Array };
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(match[1], sandbox);
  return Buffer.concat((sandbox.self.__FLIGHT_DATA || []).map(value => typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)));
}

async function audit(inject) {
  const basic = await collect(stream([bytes('<html><body>hello</body></html>')]).pipeThrough(inject(stream([bytes('safe payload')]))));
  assert.equal(flightBytes(basic).toString(), 'safe payload');
  assert.ok(basic.endsWith('</body></html>'));
  // Deliberately deliver a tag in separate event-loop turns, beyond either
  // scheduler's batching window. A valid injector must never insert inside it.
  const split = new ReadableStream({ async start(controller) {
    controller.enqueue(bytes('<html><body><div title="first'));
    await delay(30);
    controller.enqueue(bytes(' second">content</div></body></html>'));
    controller.close();
  } });
  const splitResult = await collect(split.pipeThrough(inject(stream([bytes('payload')]))));
  const splitAttributeCorrupted = splitResult.includes('title="first<script');
  const binary = [Uint8Array.of(0xe2), Uint8Array.of(0xff)];
  const binaryResult = await collect(stream([bytes('<html><body></body></html>')]).pipeThrough(inject(stream(binary))));
  const binaryPrefixLost = !flightBytes(binaryResult).equals(Buffer.concat(binary));
  let largeBinaryError;
  try {
    await collect(stream([bytes('<html><body></body></html>')]).pipeThrough(inject(stream([new Uint8Array(256 * 1024).fill(255)]))));
  } catch (error) { largeBinaryError = error.name; }
  // Stop output consumption after the shell. The producer is finite so this
  // probe terminates even when the injector does not honor downstream demand.
  let produced = 0;
  const flight = new ReadableStream({ pull(controller) {
    if (produced === 128) { controller.close(); return; }
    produced++;
    controller.enqueue(bytes('x'.repeat(4096)));
  } });
  const reader = stream([bytes('<html><body></body></html>')]).pipeThrough(inject(flight)).getReader();
  await reader.read();
  await delay(20);
  const producedWhileConsumerPaused = produced;
  while (!(await reader.read()).done) { /* drain only after measurement */ }
  let flightCancelled = false, htmlCancelled = false, finishFlight;
  const pendingFlight = new ReadableStream({
    start(controller) { controller.enqueue(bytes('pending')); finishFlight = () => controller.close(); },
    cancel() { flightCancelled = true; },
  });
  const pendingHtml = new ReadableStream({
    start(controller) { controller.enqueue(bytes('<html><body>shell')); },
    cancel() { htmlCancelled = true; },
  });
  const cancelledReader = pendingHtml.pipeThrough(inject(pendingFlight)).getReader();
  await cancelledReader.read();
  await delay(10); // allow the writer to reach its pending read before abort
  await cancelledReader.cancel('consumer disconnected');
  await delay(10);
  const cancellation = { htmlCancelled, flightCancelled };
  // Finish the otherwise leaked producer so the audit itself does not leak.
  if (!flightCancelled) finishFlight();
  await delay(0);
  return { basic: 'pass', splitAttributeCorrupted, binaryPrefixLost, largeBinaryError, producedWhileConsumerPaused, totalChunks: 128, cancellation };
}

const results = { capturedAt: new Date().toISOString(), dependency: 'rsc-html-stream@0.0.8', upstreamSha256: hash(source), candidateSha256: hash(candidate), upstream: await audit(upstream), immediate: await audit(immediate), decision: 'REJECT: scheduler substitution does not fix token boundaries, binary integrity, downstream backpressure, or producer cancellation.' };
await mkdir(join(root, 'artifacts/verification'), { recursive: true });
await writeFile(join(root, 'artifacts/verification/transport-audit.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

async function benchmark(name) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['benchmarks/compare.mjs', '--skip-build', '--requests', '200', '--cold-runs', '1', '--concurrency', '1', '--output', `artifacts/verification/transport-${name}.json`], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`benchmark ${name} failed: ${code}`)));
  });
}

try {
  if (process.argv.includes('--benchmark')) {
    const ssrEntry = join(root, '.zap/benchmarks/zap/.zap/output/ssr/index.js');
    const original = await readFile(ssrEntry, 'utf8');
    const marker = 'from "rsc-html-stream/server"';
    assert.equal(original.split(marker).length, 2, 'Expected one external hydration transport import');
    await benchmark('upstream');
    try {
      await writeFile(ssrEntry, original.replace(marker, `from ${JSON.stringify(pathToFileURL(candidatePath).href)}`));
      await benchmark('immediate');
    } finally {
      await writeFile(ssrEntry, original);
      assert.equal(await readFile(ssrEntry, 'utf8'), original, 'Restore original generated fixture');
    }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
