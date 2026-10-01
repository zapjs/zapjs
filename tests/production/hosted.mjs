import assert from 'node:assert/strict';
const base = process.argv[2];
if (!base || new URL(base).protocol !== 'https:') throw new Error('Provide the isolated HTTPS deployment URL');
const checks = [];
async function check(path, status, pattern, headers = {}) {
  const response = await fetch(new URL(path, base), { headers });
  const body = await response.text();
  assert.equal(response.status, status, `${path}: ${body.slice(0,200)}`);
  assert.match(body, pattern);
  checks.push({ path, status, cache: response.headers.get('x-vercel-cache'), build: response.headers.get('x-zap-build') });
  return { response, body };
}
const { body: html } = await check('/', 200, /Zap framework verification/);
await check('/products/42', 200, /hosted-marker/, { 'x-test-request': 'hosted-marker' });
await check('/api/echo?q=hosted', 200, /"query":"hosted"/);
await check('/static', 200, /Prerendered public page/);
await check('/static', 200, /Prerendered public page/);
await check('/static', 200, /Prerendered public page/, { accept: 'text/x-component' });
await check('/probe.txt', 200, /Zap static asset/);
await check('/absent', 404, /Page not found/);
const formHTML = html.match(/<form[\s\S]*?<\/form>/)?.[0];
assert.ok(formHTML);
const form = new FormData();
const entities = { '&quot;': '"', '&amp;': '&', '&#x27;': "'", '&lt;': '<', '&gt;': '>' };
for (const input of formHTML.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/g)) {
  const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? '';
  form.append(input[1], value.replace(/&quot;|&amp;|&#x27;|&lt;|&gt;/g, entity => entities[entity]));
}
form.set('name', 'Hosted');
const saved = await fetch(base, { method: 'POST', headers: { origin: new URL(base).origin }, body: form });
assert.equal(saved.status, 200);
assert.match(saved.headers.get('set-cookie'), /zap-name=Hosted/);
assert.match(await saved.text(), /Saved Hosted/);
const bytes = new Uint8Array([0, 255, 128, 42]);
const echo = await fetch(new URL('/api/echo', base), { method: 'POST', body: bytes });
assert.equal(echo.status, 201);
assert.deepEqual(new Uint8Array(await echo.arrayBuffer()), bytes);
assert.equal(echo.headers.getSetCookie().length, 2);
const denied = await fetch(base, { method: 'POST', headers: { origin: 'https://other.invalid' }, body: '' });
assert.equal(denied.status, 403);
const streamObservations = [];
for (let attempt = 0; attempt < 3; attempt++) {
  const start = performance.now();
  const streamed = await fetch(new URL('/api/stream', base), { headers: { 'accept-encoding': 'identity' } });
  assert.equal(streamed.status, 200);
  const reader = streamed.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ elapsedMs: performance.now() - start, text: new TextDecoder().decode(value) });
  }
  assert.equal(chunks.map(chunk => chunk.text).join(''), 'first\nlast\n');
  streamObservations.push(chunks);
}
const failed = await fetch(new URL('/broken', base));
assert.doesNotMatch(await failed.text(), /Private fixture failure/);
console.log(JSON.stringify({ deployment: base, checks, actions: true, binary: true, cookies: true, originProtection: true, streamingBody: true, streamObservations, errorRedaction: true }, null, 2));
