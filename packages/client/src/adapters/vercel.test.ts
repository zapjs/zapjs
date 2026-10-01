import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, cp, rm, readFile, readlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Exercise the emitted JavaScript adapter, just as an installed CLI does.
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const { emitVercelOutput } = await import(new URL('../../dist/adapters/vercel.js', import.meta.url).href);
const { previewOutput } = await import(new URL('../../dist/adapters/preview.js', import.meta.url).href);

test('Vercel function runs from a relocated dependency closure with app source removed', async () => {
  const app = await mkdtemp(join(tmpdir(), 'zap-closure-app-'));
  const isolated = await mkdtemp(join(tmpdir(), 'zap-closure-deploy-'));
  try {
    await mkdir(join(app, '.zap/output/server'), { recursive: true });
    await mkdir(join(app, '.zap/output/static'), { recursive: true });
    await symlink(resolve(packageRoot, '../../node_modules'), join(app, 'node_modules'));
    await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(app, '.zap/output/server/index.js'), `import mime from 'mime-types'; export default request => Response.json({type:mime.lookup('file.css'), path:new URL(request.url).pathname});`);
    await writeFile(join(app, '.zap/output/static/asset.txt'), 'asset');
    await writeFile(join(app, '.zap/output/manifest.json'), JSON.stringify({ version: 1, capabilities: { native: false }, routes: [], prerender: [{ path: '/page', html: 'page.html', flight: 'page.rsc', status: 200, headers: { 'x-zap-build': 'test-build' } }] }));
    const output = await emitVercelOutput(app);
    const config = JSON.parse(await readFile(join(output, 'config.json'), 'utf8'));
    expect(config.version).toBe(3);
    const destination = (accept: string) => config.routes.find((route: { src?: string; has?: { value: string }[] }) => route.src === '^/page$' && (!route.has || new RegExp(route.has[0]!.value).test(accept)));
    expect(destination('text/x-component').dest).toBe('/page.rsc');
    expect(destination('Text/X-Component').dest).toBe('/page.rsc');
    expect(destination('text/x-component;q=0,text/html').dest).toBe('/zap');
    expect(destination('text/html,text/x-component;q=0.9').dest).toBe('/zap');
    expect(destination('text/html').dest).toBe('/page.html');
    expect(destination('text/x-component').headers['x-zap-build']).toBe('test-build');
    // Preserve the adapter's relative links when relocating the artifact. The
    // default copy can rewrite them to absolute paths into the soon-deleted app.
    const functionDir = join(output, 'functions/zap.func');
    await cp(functionDir, isolated, { recursive: true, verbatimSymlinks: true });
    const dependencyLink = join('files', app, 'node_modules');
    expect(await readlink(join(isolated, dependencyLink))).toBe(await readlink(join(functionDir, dependencyLink)));
    await rm(app, { recursive: true, force: true });
    const invocation = spawnSync('node', ['--input-type=module', '-e', `
      import {createServer} from 'node:http';
      import handler from './index.mjs';
      const server=createServer(handler);
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/from-isolated');
      console.log(await response.text());
      await new Promise(resolve=>server.close(resolve));
    `], { cwd: isolated, encoding: 'utf8', timeout: 15_000 });
    expect(invocation.stderr).toBe('');
    expect(invocation.status).toBe(0);
    expect(JSON.parse(invocation.stdout)).toEqual({ type: 'text/css', path: '/from-isolated' });
    const runtime = JSON.parse(await readFile(join(isolated, '.vc-config.json'), 'utf8'));
    expect(runtime.supportsResponseStreaming).toBe(true);
  } finally {
    await rm(app, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  }
}, 30_000);

test('preview serves only contained static files and honors prerender HTML/Flight selection', async () => {
  const app = await mkdtemp(join(tmpdir(), 'zap-preview-'));
  let server: import('node:http').Server | undefined;
  try {
    await mkdir(join(app, 'server'), { recursive: true });
    await mkdir(join(app, 'static'), { recursive: true });
    await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(app, 'server/index.js'), `export default () => new Response('dynamic',{status:404});`);
    await writeFile(join(app, 'secret.txt'), 'private-secret');
    await symlink(join(app, 'secret.txt'), join(app, 'static/leak.txt'));
    await writeFile(join(app, 'static/page.html'), '<h1>Static page</h1>');
    await writeFile(join(app, 'static/page.rsc'), 'flight-payload');
    await writeFile(join(app, 'manifest.json'), JSON.stringify({ prerender: [{ path: '/page', html: 'page.html', flight: 'page.rsc', status: 200, headers: { 'cache-control': 'public, max-age=60' } }] }));
    server = await previewOutput(app, { port: 0 });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/page`)).text()).toBe('<h1>Static page</h1>');
    const flight = await fetch(`${base}/page`, { headers: { accept: 'text/x-component' } });
    expect(await flight.text()).toBe('flight-payload');
    expect(flight.headers.get('content-type')).toBe('text/x-component');
    for (const accept of ['text/x-component;q=0,text/html', 'text/x-component;q=0.5,text/html;q=0.9']) {
      expect(await (await fetch(`${base}/page`, { headers: { accept } })).text()).toBe('<h1>Static page</h1>');
    }
    expect(await (await fetch(`${base}/page`, { headers: { accept: 'text/html;q=0.5,Text/X-Component;q=0.9' } })).text()).toBe('flight-payload');
    for (const path of ['/leak.txt', '/%2e%2e%2fsecret.txt']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('private-secret');
    }
    expect((await fetch(`${base}/page`, { method: 'POST' })).status).toBe(404);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(app, { recursive: true, force: true });
  }
});
