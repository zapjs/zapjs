#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = await mkdtemp(join(tmpdir(), 'zap-native-dev-'));
const app = join(parent, 'application');
const cli = join(root, 'packages/client/dist/cli/index.js');
// CI can select an already installed equivalent toolchain; source deployments use the pinned toolchain.
const env = { ...process.env, NODE_ENV: 'development' };
let child;
let output = '';
const observed = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = () => execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
}).filter(Boolean);
const recordChildren = () => {
  if (!child?.pid) return;
  const rows = processes();
  const parents = new Set([child.pid, ...observed]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (parents.has(row.parent) && !parents.has(row.pid)) {
      parents.add(row.pid); observed.add(row.pid); changed = true;
    }
  }
};
const eventually = async (check, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    recordChildren();
    try { await check(); return; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`${last?.message ?? 'Condition timed out'}\nDevelopment output:\n${output}`);
};
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  recordChildren();
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(force); }
};
try {
  execFileSync(process.execPath, [cli, 'new', app, '--native', '--no-install', '--no-git'], { cwd: root, env, stdio: 'pipe' });
  await symlink(join(root, 'node_modules'), join(app, 'node_modules'), 'dir');
  execFileSync('cargo', ['generate-lockfile', '--manifest-path', 'native/Cargo.toml'], { cwd: app, env, stdio: 'pipe', timeout: 120000 });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [cli, 'dev', '--port', String(port), '--host', '127.0.0.1'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const matches = async value => {
    const response = await fetch(`${base}/api/native`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sum: value });
  };
  await eventually(() => matches(42));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(app, 'tsconfig.json')], { cwd: app, env, stdio: 'pipe', timeout: 30000 });
  const source = join(app, 'native/src/lib.rs');
  const original = await readFile(source, 'utf8');
  assert.match(original, /checked_add/);
  await writeFile(source, original.replace('let mut total = 0u32;', 'let mut total = 1u32;'));
  await eventually(() => matches(43));
  const diagnosticStart = output.length;
  await writeFile(source, original + '\nthis deliberately does not compile\n');
  await eventually(() => assert.match(output.slice(diagnosticStart), /error:|error\[E/));
  await writeFile(source, original);
  await eventually(() => matches(42));
  // Verify domain failures from the generated example through the actual addon.
  const manifest = JSON.parse(await readFile(join(app, '.zap/native/manifest.json'), 'utf8'));
  assert.ok(manifest.exports.includes('sumNumbers'));
  const { sumNumbers } = await import(pathToFileURL(join(app, '.zap/native/index.mjs')).href);
  assert.equal(await sumNumbers([4294967295]), 4294967295);
  await assert.rejects(sumNumbers([4294967296]), /Values must be unsigned 32-bit integers/);
  await assert.rejects(sumNumbers([4294967295, 1]), /Sum exceeds unsigned 32-bit range/);
  await assert.rejects(sumNumbers([1.5]), /Values must be unsigned 32-bit integers/);
  await assert.rejects(sumNumbers([-1]), /Values must be unsigned 32-bit integers/);
  // Stop during a real Cargo build so its subprocess tree must also terminate.
  const restartStart = output.length;
  await writeFile(join(app, 'native/build.rs'), 'fn main() { println!("cargo:warning=ZAP_TEST_BUILD_WAIT"); std::thread::sleep(std::time::Duration::from_secs(20)); napi_build::setup(); }\n');
  await eventually(() => {
    assert.match(output.slice(restartStart), /Compiling/);
    assert.ok(processes().some(row => row.command.includes('build-script-build') && observed.has(row.pid)));
  });
  await stop();
  await eventually(() => {
    const remaining = processes().filter(row => observed.has(row.pid));
    assert.deepEqual(remaining, []);
  }, 10000);
  console.log('Native development verification passed: generated app, real addon response, Rust rebuild, compiler diagnostics and recovery, checked arithmetic, shutdown during Cargo build with no surviving descendants.');
} finally {
  await stop();
  // Only terminate descendants observed under this test's CLI when a failure prevented normal shutdown.
  for (const row of processes()) if (observed.has(row.pid)) {
    try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await rm(parent, { recursive: true, force: true });
}
