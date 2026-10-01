#!/usr/bin/env node
/** Local, reproducible framework-core comparison. No performance claims without a result. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const NEXT_VERSION = '16.3.8';
const REACT_VERSION = '19.3.0';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const count = Number(option('--requests', '200'));
const coldRuns = Number(option('--cold-runs', '3'));
const concurrencyLevels = option('--concurrency', '1,16').split(',').map(Number);
const skipBuild = args.includes('--skip-build');
const order = option('--order', 'zap,next').split(',');
assert.deepEqual([...order].sort(), ['next', 'zap']);
assert.ok(Number.isInteger(count) && count > 0);
assert.ok(Number.isInteger(coldRuns) && coldRuns > 0);
assert.ok(concurrencyLevels.every(value => Number.isInteger(value) && value > 0));
const workspace = join(root, '.zap/benchmarks');
const resultPath = resolve(option('--output', join(root, 'artifacts/verification/benchmark-local.json')));
const environment = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1' };
const apps = { zap: join(workspace, 'zap'), next: join(workspace, 'next') };
const cli = join(root, 'packages/client/dist/cli/index.js');
const buildMetrics = {};
const processes = new Set();

async function write(rootDir, path, contents) {
  const file = join(rootDir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}
function command(command, args, cwd, timeout = 300_000) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  return { milliseconds: performance.now() - started, output: result.stdout + result.stderr };
}

async function fixtures() {
  const common = {
    'app/layout.tsx': `import type {ReactNode} from 'react'; export default function Layout({children}:{children:ReactNode}) { return <html lang="en"><body>{children}</body></html>; }`,
    'app/counter.tsx': `'use client'; import {useState} from 'react'; export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>Count: {n}</button>}`,
    'app/page.tsx': `import Counter from './counter'; export const dynamic='force-dynamic'; export default async function Page(){return <main><h1>Equivalent dynamic page</h1><p>Server rendered content</p><Counter/></main>}`,
    'app/stream/page.tsx': `import {Suspense} from 'react'; import Counter from '../counter'; export const dynamic='force-dynamic'; async function Delayed(){await new Promise(r=>setTimeout(r,60));return <p>Delayed server content</p>} export default function Page(){return <main><h1>Equivalent streamed page</h1><Counter/><Suspense fallback={<p>Loading delayed content</p>}><Delayed/></Suspense></main>}`,
    'app/api/echo/route.ts': `export const dynamic='force-dynamic'; export async function GET(request:Request){return Response.json({value:new URL(request.url).searchParams.get('value')},{headers:{'cache-control':'private, no-store'}})}`,
    'app/api/cpu/route.ts': `export const dynamic='force-dynamic'; export async function GET(){let checksum=0;for(let i=0;i<250000;i++) checksum=(checksum+Math.imul(i,2654435761))>>>0;return Response.json({checksum},{headers:{'cache-control':'private, no-store'}})}`,
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true }, include: ['app/**/*.ts', 'app/**/*.tsx'] }),
  };
  for (const [name, app] of Object.entries(apps)) {
    await mkdir(app, { recursive: true });
    for (const [path, contents] of Object.entries(common)) await write(app, path, contents);
    await write(app, 'package.json', JSON.stringify({
      name: `zap-comparison-${name}`, private: true, type: 'module',
      dependencies: name === 'next' ? { next: NEXT_VERSION, react: REACT_VERSION, 'react-dom': REACT_VERSION } : { '@zap-js/client': '0.3.0', react: REACT_VERSION, 'react-dom': REACT_VERSION },
      devDependencies: { typescript: '5.9.3', '@types/react': '19.2.14', '@types/node': '22.19.15' },
    }, null, 2));
  }
  try { await symlink(join(root, 'node_modules'), join(apps.zap, 'node_modules')); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  console.log(`Installing isolated Next ${NEXT_VERSION} baseline...`);
  command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], apps.next);
  assert.equal(JSON.parse(await readFile(join(apps.next, 'node_modules/next/package.json'), 'utf8')).version, NEXT_VERSION);
  await write(apps.zap, 'run.mjs', `process.env.NODE_ENV='production'; const {previewOutput}=await import(${JSON.stringify(pathToFileURL(join(root, 'packages/client/dist/adapters/preview.js')).href)});const server=await previewOutput('.zap/output',{port:Number(process.env.PORT),host:'127.0.0.1'});console.log('BENCH_READY');process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});`);
}

async function sumJs(directory) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const child = await sumJs(path); bytes += child.bytes; files += child.files; }
    else if (entry.name.endsWith('.js')) { bytes += (await stat(path)).size; files++; }
  }
  return { bytes, files };
}
async function freePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
async function start(name) {
  const port = await freePort();
  const args = name === 'zap' ? ['run.mjs'] : ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'];
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: apps[name], env: { ...environment, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let logs = '';
  child.stdout.on('data', value => logs += value);
  child.stderr.on('data', value => logs += value);
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 30_000;
  while (!logs.includes(name === 'zap' ? 'BENCH_READY' : 'Ready in')) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`${name} exited:\n${logs}`);
    if (Date.now() > deadline) throw new Error(`${name} startup timed out:\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { child, base: `http://127.0.0.1:${port}`, startupMs: performance.now() - started, logs: () => logs };
}
async function stop(instance) {
  const child = instance.child;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(force); resolve(); });
      child.kill('SIGTERM');
    });
  }
  processes.delete(child);
}
function resources(pid) {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'rss=', '-o', 'time='], { encoding: 'utf8' }).trim();
    const [rss, cpu] = output.split(/\s+/);
    const parts = cpu.split(':').map(Number);
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    return { rssBytes: Number(rss) * 1024, cpuSeconds: seconds };
  } catch { return null; }
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}
function distribution(values) { return { p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) }; }
const workloads = [
  { name: 'api-echo', path: '/api/echo?value=42', expected: '"value":"42"' },
  { name: 'api-js-cpu', path: '/api/cpu', expected: '"checksum":' },
  { name: 'dynamic-rsc-html', path: '/', expected: 'Equivalent dynamic page' },
  { name: 'streamed-rsc-html', path: '/stream', expected: 'Delayed server content' },
];
async function request(base, workload) {
  const start = performance.now();
  const response = await fetch(base + workload.path, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(30_000) });
  const reader = response.body.getReader();
  let firstByteMs;
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    firstByteMs ??= performance.now() - start;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (response.status !== 200 || !text.includes(workload.expected)) throw new Error(`Unexpected ${workload.name} response: ${response.status} ${text.slice(0, 200)}`);
  return { firstByteMs: firstByteMs ?? performance.now() - start, totalMs: performance.now() - start, bytes };
}
async function warm(instance, workload, concurrency) {
  for (let i = 0; i < 10; i++) await request(instance.base, workload);
  const before = resources(instance.child.pid);
  let cursor = 0;
  const samples = [], errors = [];
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= count) return;
      try { samples.push(await request(instance.base, workload)); }
      catch (error) { errors.push(String(error)); }
    }
  }));
  const elapsed = performance.now() - start;
  const after = resources(instance.child.pid);
  return {
    requests: count, concurrency, successes: samples.length, errors: errors.length, errorExamples: errors.slice(0, 3),
    elapsedMs: elapsed, requestsPerSecond: samples.length / (elapsed / 1000),
    firstByteMs: distribution(samples.map(sample => sample.firstByteMs)), totalMs: distribution(samples.map(sample => sample.totalMs)),
    responseBytes: distribution(samples.map(sample => sample.bytes)),
    cpuSeconds: before && after ? after.cpuSeconds - before.cpuSeconds : null,
    sampledRssBytes: after?.rssBytes ?? null,
  };
}

try {
  await mkdir(workspace, { recursive: true });
  if (!skipBuild) {
    await fixtures();
    for (const name of order) {
      console.log(`Building ${name}...`);
      await rm(join(apps[name], name === 'next' ? '.next' : '.zap/output'), { recursive: true, force: true });
      const build = name === 'zap' ? command(process.execPath, [cli, 'build', '--adapter', 'node'], apps.zap) : command(process.execPath, ['node_modules/next/dist/bin/next', 'build'], apps.next);
      buildMetrics[name] = { milliseconds: build.milliseconds };
      await writeFile(join(workspace, `${name}-build.log`), build.output);
    }
    await writeFile(join(workspace, 'build-metrics.json'), JSON.stringify(buildMetrics));
  } else Object.assign(buildMetrics, JSON.parse(await readFile(join(workspace, 'build-metrics.json'), 'utf8')));
  if (args.includes('--build-only')) { console.log('Benchmark fixtures built; run with --skip-build to measure without competing builds.'); process.exit(0); }
  const results = {
    measuredAt: new Date().toISOString(), versions: { zap: '0.3.0-working-tree', next: NEXT_VERSION, react: REACT_VERSION, node: process.version, v8: process.versions.v8 },
    host: { platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg() },
    settings: { order, requestsPerWorkload: count, concurrencyLevels, coldRuns, warmupRequests: 10, acceptEncoding: 'identity', streamedDelayMs: 60, cpuIterations: 250_000 },
    scope: 'Local framework-core comparison of equivalent generated dynamic RSC/HTML and API fixtures. No CDN, native acceleration, database, browser hydration, managed cold-start, or feature-parity claim. Servers run sequentially in separate processes on a shared unpinned host.',
    git: { revision: command('git', ['rev-parse', 'HEAD'], root).output.trim(), dirty: !!command('git', ['status', '--porcelain'], root).output.trim() },
    frameworks: {},
  };
  for (const name of order) {
    const data = { build: buildMetrics[name], emittedClientJavaScript: await sumJs(join(apps[name], name === 'zap' ? '.zap/output/static' : '.next/static')), cold: [], warm: {} };
    results.frameworks[name] = data;
    for (let trial = 0; trial < coldRuns; trial++) {
      const instance = await start(name);
      try {
        const response = await request(instance.base, workloads[2]);
        data.cold.push({ startupMs: instance.startupMs, ...response, ...resources(instance.child.pid) });
      } finally { await stop(instance); }
    }
    const instance = await start(name);
    try {
      for (const workload of workloads) {
        data.warm[workload.name] = [];
        for (const concurrency of concurrencyLevels) {
          console.log(`Measuring ${name}: ${workload.name}, concurrency ${concurrency}, ${count} requests...`);
          data.warm[workload.name].push(await warm(instance, workload, concurrency));
        }
      }
      await writeFile(join(workspace, `${name}-runtime.log`), instance.logs());
    } finally { await stop(instance); }
  }
  results.host.loadAverageAfter = loadavg();
  results.fixtureSha256 = createHash('sha256').update(await readFile(join(apps.zap, 'app/page.tsx'))).update(await readFile(join(apps.zap, 'app/api/cpu/route.ts'))).digest('hex');
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(results, null, 2));
  console.log(`Measured result: ${resultPath}`);
  if (Object.values(results.frameworks).some(framework => Object.values(framework.warm).flat().some(sample => sample.errors))) process.exitCode = 1;
  for (const [name, result] of Object.entries(results.frameworks)) {
    console.log(`${name}: build ${result.build.milliseconds.toFixed(0)} ms; client JS ${result.emittedClientJavaScript.bytes} bytes`);
    for (const [workload, samples] of Object.entries(result.warm)) for (const sample of samples) console.log(`${name} ${workload} c=${sample.concurrency}: ${sample.requestsPerSecond.toFixed(1)} rps, p50/p95/p99=${[sample.totalMs.p50,sample.totalMs.p95,sample.totalMs.p99].map(x=>x?.toFixed(2)).join('/')} ms, errors=${sample.errors}`);
  }
} finally {
  for (const child of processes) child.kill('SIGKILL');
}
