#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = resolve(process.argv[2] || join(root, 'artifacts/verification/combined-cloud'));
const replace = process.argv.includes('--replace');
if (process.argv[2]?.startsWith('--')) throw new Error('Usage: node tests/production/prepare-cloud.mjs [destination] [--replace]');
const marker = '.zap-cloud-fixture.json';
try {
  await access(destination);
  if (!replace) throw new Error(`Fixture already exists: ${destination}. Pass --replace to replace a previously generated fixture.`);
  const previous = JSON.parse(await readFile(join(destination, marker), 'utf8'));
  assert.equal(previous.kind, 'zap-combined-cloud-fixture', 'Refusing to replace an unrecognized directory');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (replace) {
    // A missing destination is safe; an existing directory without the marker is not.
    try { await access(destination); throw new Error(`Refusing to replace an unrecognized directory: ${destination}`); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
  }
}
const frameworkRoot = join(root, 'packages/client');
const framework = JSON.parse(await readFile(join(frameworkRoot, 'package.json'), 'utf8'));
assert.equal(framework.scripts.prepare, undefined, 'Packing must not rebuild or mutate the authoritative dist snapshot');
await access(join(frameworkRoot, 'dist/native/rust/Cargo.toml'));
await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(join(dirname(destination), '.combined-cloud-'));
const app = join(staging, 'combined-cloud');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  // The caller builds dist first. Packing never runs build scripts or publishes.
  const packages = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', staging, frameworkRoot]));
  assert.equal(packages.length, 1);
  const archive = packages[0].filename;
  run(process.execPath, [join(frameworkRoot, 'dist/cli/index.js'), 'new', app, '--native', '--no-install', '--no-git']);
  await rm(join(app, 'app'), { recursive: true });
  await cp(join(root, 'tests/fixtures/fullstack/app'), join(app, 'app'), { recursive: true });
  await cp(join(root, 'tests/fixtures/fullstack/public'), join(app, 'public'), { recursive: true });
  await cp(join(root, 'tests/fixtures/native/app'), join(app, 'app'), { recursive: true });
  await cp(join(root, 'tests/fixtures/native/native'), join(app, 'native'), { recursive: true });
  // One source of truth for napi-rs exports: the same fixture used by addon tests.
  await cp(join(root, 'packages/native/fixtures/addon/native/src/lib.rs'), join(app, 'native/src/lib.rs'));
  await cp(join(root, 'packages/native/fixtures/addon/native/build.rs'), join(app, 'native/build.rs'));
  await rename(join(staging, archive), join(app, archive));
  const packageJson = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  packageJson.name = 'zapjs-combined-cloud-fixture';
  packageJson.dependencies['@zap-js/client'] = `file:${archive}`;
  // Vercel's generated function runtime uses Node 22; keep its build runtime aligned.
  packageJson.engines.node = '22.x';
  await writeFile(join(app, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
  run('npm', ['install', '--no-audit', '--no-fund'], app);
  // cargo metadata checks portable SDK resolution and the committed native lock.
  run('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', 'native/Cargo.toml'], app);
  await writeFile(join(app, marker), JSON.stringify({ kind: 'zap-combined-cloud-fixture', version: 1, frameworkVersion: framework.version, integrity: packages[0].integrity, sources: ['tests/fixtures/fullstack', 'tests/fixtures/native', 'packages/native/fixtures/addon/native', 'zap new --native'] }, null, 2) + '\n');
  await writeFile(join(app, 'README.md'), `# Combined managed deployment verification\n\nThis generated fixture combines the checked-in fullstack and native sources. The framework tarball includes its Rust SDK. Deploy this source directory with Vercel CLI; do not use --prebuilt. Managed install/build scripts provision pinned Rust 1.92.0 and compile the addon on Linux.\n\nThe home page exercises React clients, streaming and server actions. /static is prerendered; /products/42 preserves request context; /native invokes Rust in a server component. /api/native checks typed Rust results and errors; /api/bytes returns native binary data.\n\nFrom the repository run node tests/production/hosted.mjs URL and node tests/production/native-hosted.mjs URL after deployment. Browser acceptance uses Aegis.\n`);
  if (replace) await rm(destination, { recursive: true, force: true });
  await rename(app, destination);
  console.log(JSON.stringify({ destination, frameworkVersion: framework.version, integrity: packages[0].integrity, prepared: true, deployed: false }, null, 2));
} catch (error) {
  if (error.stdout || error.stderr) console.error(String(error.stdout || '') + String(error.stderr || ''));
  throw error;
} finally {
  await rm(staging, { recursive: true, force: true });
}
