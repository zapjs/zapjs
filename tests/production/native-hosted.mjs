import assert from 'node:assert/strict';
const base = process.argv[2];
if (!base) throw new Error('Usage: node tests/production/native-hosted.mjs https://deployment.example');
const page = await fetch(new URL('/native', base));
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /ZapJS managed native proof/);
assert.match(html, /Native total:[\s\S]*42/);
assert.match(html, /server-component/);
const flight = await fetch(new URL('/native', base), { headers: { accept: 'text/x-component' } });
assert.equal(flight.status, 200);
assert.match(flight.headers.get('content-type'), /^text\/x-component/);
assert.match(await flight.text(), /native-total/);
for (const authenticated of [false, true]) {
  const headers = { 'x-request-id': `managed-${authenticated}` };
  if (authenticated) headers.authorization = 'fixture-token';
  const response = await fetch(new URL('/api/native', base), { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sum: 42, count: 2, requestId: `managed-${authenticated}`, authenticated });
}
const failed = await fetch(new URL('/api/native?fail=1', base));
assert.equal(failed.status, 422);
assert.deepEqual(await failed.json(), { error: 'Values must be finite' });
const bytes = await fetch(new URL('/api/bytes', base), { method: 'POST', body: new Uint8Array([0, 255, 128, 1]) });
assert.equal(bytes.status, 200);
assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), new Uint8Array([1, 128, 255, 0]));
console.log(JSON.stringify({ base, result: 'pass', checks: ['native-react-ssr', 'native-react-flight', 'request-context-present-and-absent', 'native-error', 'native-buffer'] }, null, 2));
