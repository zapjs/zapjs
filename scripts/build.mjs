#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const client = join(root, 'packages/client');
await rm(join(client, 'dist'), { recursive: true, force: true });
const result = spawnSync('bun', ['x', '--no-install', 'tsc', '-p', join(client, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const sdk = join(client, 'dist/native/rust');
await mkdir(sdk, { recursive: true });
await cp(join(root, 'packages/native/Cargo.toml'), join(sdk, 'Cargo.toml'));
await cp(join(root, 'packages/native/src'), join(sdk, 'src'), { recursive: true });
