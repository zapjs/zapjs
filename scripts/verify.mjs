#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const steps = [
  ['node', ['scripts/build.mjs']],
  ['cargo', ['test', '--workspace']],
  ['bun', ['test', 'packages/client/src']],
  ['node', ['--import', 'tsx', '--test', 'packages/native/test.mjs']],
  ['node', ['tests/production/framework.mjs']],
  ['node', ['tests/production/dev.mjs']],
  ['node', ['tests/production/skew.mjs']],
  ['node', ['tests/production/prerender.mjs']],
  ['node', ['tests/production/native.mjs']],
  ['node', ['tests/production/native-dev.mjs']],
  ['node', ['tests/production/package.mjs']],
];
for (const [command, args] of steps) {
  console.log(`Verifying: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 600_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Source, native, managed-output, and package verification passed. Browser and hosted-deployment evidence are separate release gates.');
