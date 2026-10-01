import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newCommand } from './new.js';
import { scanGraph } from '../../compiler/graph.js';

test('generated application uses the canonical graph and can include typed native compute', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'zap-new-'));
  const app = join(parent, 'my-app');
  try {
    await newCommand(app, { install: false, git: false, native: true });
    const packageJson = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    expect(packageJson.scripts.build).toBe('zap build');
    expect(packageJson.scripts.preview).toBe('zap preview');
    expect(packageJson.dependencies['@zap-js/client']).toBeDefined();
    expect(Object.keys(packageJson.dependencies).some(name => name.startsWith('@zapjs/'))).toBe(false);
    const graph = scanGraph(app);
    expect(graph.routes.map(route => route.path).sort()).toEqual(['/', '/about', '/api/health', '/api/native']);
    expect(await readFile(join(app, 'app/api/health/route.ts'), 'utf8')).toContain('Response.json');
    expect(await readFile(join(app, 'native/Cargo.toml'), 'utf8')).toContain('crate-type = ["cdylib"]');
    const native = await readFile(join(app, 'native/src/lib.rs'), 'utf8');
    expect(native).toContain('zap_native::compute');
    expect(native).toContain('checked_add');
    expect(native).not.toContain('wrapping_add');
    expect(native).toContain('Sum exceeds unsigned 32-bit range');
    expect(await readFile(join(app, 'rust-toolchain.toml'), 'utf8')).toContain('channel = "1.92.0"');
    const deployment = JSON.parse(await readFile(join(app, 'vercel.json'), 'utf8'));
    expect(deployment.installCommand).toBe('sh scripts/install.sh');
    expect(deployment.buildCommand).toBe('sh scripts/build.sh');
    const install = await readFile(join(app, 'scripts/install.sh'), 'utf8');
    expect(install).toContain('https://sh.rustup.rs');
    expect(install).toContain('--default-toolchain 1.92.0');
    expect(install).toContain('npm ci');
    expect(await readFile(join(app, 'README.md'), 'utf8')).toContain('vercel deploy');
    expect(await readFile(join(app, '.vercelignore'), 'utf8')).toContain('.zap');
    await expect(stat(join(app, 'server'))).rejects.toThrow();
    await expect(newCommand(app, { install: false, git: false })).rejects.toThrow('already exists');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
