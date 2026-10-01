#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(join(tmpdir(), 'zap-installed-'));
const app = join(temporary, 'app');
const packageRoot = join(root, 'packages/client');
const run = (command, args, cwd = temporary, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  return result.stdout;
};
let preview;
try {
  const framework = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', temporary, packageRoot]);
  const archive = join(temporary, `zap-js-client-${framework.version}.tgz`);
  await access(archive);
  run(process.execPath, [join(packageRoot, 'dist/cli/index.js'), 'new', app, '--no-install', '--no-git']);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], app);
  const installedCli = join(app, 'node_modules/@zap-js/client/dist/cli/index.js');
  assert.equal(run(process.execPath, [installedCli, '--version'], app).trim(), framework.version);
  assert.match(run(process.execPath, [installedCli, 'routes', '--json'], app), /api\/health/);
  for (const args of [['serve'], ['codegen'], ['build', '--skip-frontend'], ['dev', '--skip-build']]) {
    const rejected = spawnSync(process.execPath, [installedCli, ...args], { cwd: app, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(rejected.status, 0, `Retired CLI surface accepted: ${args.join(' ')}`);
  }
  // A plain React application must never invoke a Rust compiler.
  const denyTools = join(temporary, 'deny-rust');
  await mkdir(denyTools);
  const compilerUsed = join(temporary, 'compiler-used');
  for (const name of ['cargo', 'rustc']) {
    const file = join(denyTools, name);
    await writeFile(file, `#!/bin/sh\nprintf invoked > '${compilerUsed.replaceAll("'", "'\\''")}'\nexit 91\n`);
    await chmod(file, 0o755);
  }
  const environment = { ...process.env, PATH: `${denyTools}:${process.env.PATH}` };
  run(process.execPath, [installedCli, 'build', '--adapter', 'node'], app, environment);
  await assert.rejects(access(compilerUsed));
  run(process.execPath, [join(app, 'node_modules/typescript/bin/tsc'), '--noEmit'], app);
  await access(join(app, 'node_modules/@zap-js/client/dist/native/rust/Cargo.toml'));
  const nativeScaffold = join(temporary, 'native-scaffold');
  run(process.execPath, [installedCli, 'new', nativeScaffold, '--native', '--no-install', '--no-git']);
  assert.match(await readFile(join(nativeScaffold, 'native/Cargo.toml'), 'utf8'), /node_modules\/@zap-js\/client\/dist\/native\/rust/);
  const declarations = await readFile(join(app, 'node_modules/@zap-js/client/dist/framework/client.d.ts'), 'utf8');
  assert.match(declarations, /Link/);
  // Preview from emitted code after removing all application sources.
  await rm(join(app, 'app'), { recursive: true });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let logs = '';
  preview = spawn(process.execPath, [installedCli, 'preview', '--port', String(port)], { cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  preview.stdout.on('data', chunk => logs += chunk);
  preview.stderr.on('data', chunk => logs += chunk);
  const deadline = Date.now() + 20_000;
  while (!logs.includes('Build preview:')) {
    assert.equal(preview.exitCode, null, logs);
    assert.ok(Date.now() < deadline, logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Your application starts here/);
  const api = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.deepEqual(await api.json(), { status: 'ok' });
  preview.kill('SIGTERM');
  await new Promise(resolve => preview.once('exit', resolve));
  console.log('PASS installed tarball: canonical scaffold, actual dependency install, typed public API, build/preview without source or Rust toolchain, retired commands rejected');
} finally {
  if (preview && preview.exitCode === null && preview.signalCode === null) preview.kill('SIGKILL');
  if (process.env.ZAP_KEEP_PACKAGE_FIXTURE) console.log(`Package fixture: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
}
