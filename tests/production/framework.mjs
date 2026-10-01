import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'zap-production-'));
let server;
try {
  await cp(join(root, 'tests/fixtures/fullstack'), workspace, { recursive: true, filter: path => !path.includes('/.zap') && !path.includes('/.vercel') && !path.includes('/node_modules') });
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(root, 'packages/client/dist/cli/index.js'), 'build'], { cwd: workspace, stdio: 'pipe', timeout: 120000 });
  const artifact = join(workspace, '.vercel/output');
  const manifest = JSON.parse(await readFile(join(workspace, '.zap/output/manifest.json'), 'utf8'));
  assert.equal(manifest.capabilities.rsc, true);
  assert.match(await readFile(join(artifact, 'static', manifest.prerender.find(entry => entry.path === '/static').html), 'utf8'), /Prerendered public page/);
  // Run only the relocated traced deployment; the application and original build disappear.
  await Promise.all(['app', 'public', '.zap', 'node_modules'].map(path => rm(join(workspace, path), { recursive: true, force: true })));
  const { default: handler } = await import(pathToFileURL(join(artifact, 'functions/zap.func/index.mjs')).href);
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /Zap framework verification/);
  let html = first;
  for (;;) { const { done, value } = await reader.read(); if (done) break; html += new TextDecoder().decode(value); }
  assert.match(html, /Streamed server component complete/);
  assert.match(html, /Count: /);
  assert.match(html, /__FLIGHT|__rsc|__RSC|push\(/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const form = new FormData();
  const formHTML = html.match(/<form[\s\S]*?<\/form>/)?.[0];
  assert.ok(formHTML, 'server-rendered form must support progressive submission');
  const entities = { '&quot;': '"', '&amp;': '&', '&#x27;': "'", '&lt;': '<', '&gt;': '>' };
  for (const input of formHTML.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/g)) {
    const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? '';
    form.append(input[1], value.replace(/&quot;|&amp;|&#x27;|&lt;|&gt;/g, entity => entities[entity]));
  }
  form.set('name', 'Grace');
  const action = await fetch(base, { method: 'POST', headers: { origin: base }, body: form });
  assert.equal(action.status, 200);
  assert.match(action.headers.get('set-cookie'), /zap-name=Grace/);
  assert.match(await action.text(), /Saved Grace/);
  const product = await fetch(`${base}/products/42`, { headers: { 'x-test-request': 'isolated-42' } });
  const productHTML = await product.text();
  assert.match(productHTML, /Product catalog/);
  assert.match(productHTML, /isolated-42/);
  const flight = await fetch(`${base}/products/42`, { headers: { accept: 'text/x-component' } });
  assert.match(flight.headers.get('content-type'), /^text\/x-component/);
  assert.match(await flight.text(), /Product/);
  const echoes = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const result = await fetch(`${base}/api/echo?q=${i}`, { headers: { 'x-test-request': `r${i}` } });
    assert.deepEqual(await result.json(), { query: String(i), marker: `r${i}`, name: null });
  }));
  assert.equal(echoes.length, 20);
  const bytes = new Uint8Array([0, 255, 128, 1, 42]);
  const binary = await fetch(`${base}/api/echo`, { method: 'POST', body: bytes });
  assert.equal(binary.status, 201);
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), bytes);
  assert.equal(binary.headers.getSetCookie().length, 2);
  const stream = await fetch(`${base}/api/stream`);
  const chunks = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await chunks.read()).value), 'first\n');
  assert.equal(new TextDecoder().decode((await chunks.read()).value), 'last\n');
  assert.equal((await chunks.read()).done, true);
  assert.equal((await fetch(`${base}/absent`)).status, 404);
  assert.equal((await fetch(`${base}/api/echo`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(base, { method: 'POST', headers: { origin: 'https://attacker.invalid' }, body: '' })).status, 403);
  assert.equal((await fetch(base, { headers: { accept: 'text/x-component', 'x-zap-build': 'old-deployment' } })).status, 409);
  assert.equal((await fetch(base, { method: 'POST', headers: { origin: base, 'x-zap-action': '' }, body: '' })).status, 400);
  const errorPage = await fetch(`${base}/broken`);
  assert.doesNotMatch(await errorPage.text(), /Private fixture failure/);
  console.log('Framework production verification passed: source-free managed function, React HTML/Flight, nested routing, 20 isolated requests, binary/cookies, streaming, prerender, origin protection, error redaction.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(workspace, { recursive: true, force: true });
}
