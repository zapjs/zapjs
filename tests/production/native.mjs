import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "zap-native-production-"));
let server;
try {
  await mkdir(join(workspace, "app/api/native"), { recursive: true });
  await mkdir(join(workspace, "app/api/bytes"), { recursive: true });
  await symlink(
    join(root, "node_modules"),
    join(workspace, "node_modules"),
    "dir",
  );
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "zap-native-production-test",
      private: true,
      type: "module",
    }),
  );
  await cp(
    join(root, "packages/native/fixtures/addon/native"),
    join(workspace, "native"),
    { recursive: true },
  );
  const cargoPath = join(workspace, "native/Cargo.toml");
  const cargo = (await readFile(cargoPath, "utf8")).replace(
    'path = "../../.."',
    `path = ${JSON.stringify(join(root, "packages/native"))}`,
  );
  await writeFile(cargoPath, cargo + "\n[workspace]\n");
  await writeFile(
    join(workspace, "app/layout.tsx"),
    `import type { ReactNode } from 'react';
export default function Layout({children}:{children:ReactNode}) { return <html><head><title>Native deployment proof</title></head><body>{children}</body></html>; }
`,
  );
  await writeFile(
    join(workspace, "app/page.tsx"),
    `import { summarize } from 'zap:native';
export default async function Page() { const result=await summarize([19,23], {requestId:'server-component'}); return <main><h1>Native deployment proof</h1><p id="native-total">Native total: {result.sum}</p></main>; }
`,
  );
  await writeFile(
    join(workspace, "app/api/native/route.ts"),
    `import { summarize } from 'zap:native';
export async function GET(request:Request) {
  try {
    const values=new URL(request.url).searchParams.has('fail') ? [Infinity] : [19,23];
    const result=await summarize(values, {requestId:request.headers.get('x-request-id') ?? 'none', authorization:request.headers.get('authorization') ?? undefined});
    return Response.json(result);
  } catch(error) { return Response.json({error:(error as Error).message}, {status:422}); }
}
`,
  );
  await writeFile(
    join(workspace, "app/api/bytes/route.ts"),
    `import { reverseBytes } from 'zap:native';
export async function POST(request:Request) { const result=await reverseBytes(Buffer.from(await request.arrayBuffer())); return new Response(result,{headers:{'content-type':'application/octet-stream'}}); }
`,
  );
  execFileSync("cargo", ["generate-lockfile", "--manifest-path", cargoPath], {
    cwd: workspace,
    stdio: "pipe",
    timeout: 120000,
  });
  execFileSync(
    process.execPath,
    [
      join(root, "packages/client/dist/cli/index.js"),
      "build",
      "--adapter",
      "node",
    ],
    { cwd: workspace, stdio: "pipe", timeout: 180000 },
  );
  const original = join(workspace, ".zap/output");
  const manifest = JSON.parse(
    await readFile(join(original, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.capabilities.native, true);
  assert.equal(manifest.native.napiVersion, 8);
  assert.ok(manifest.native.exports.includes("summarize"));
  const artifact = join(workspace, "relocated-artifact");
  await rename(original, artifact);
  // Runtime must find relative addon files after the source/build tree is gone.
  await Promise.all(
    ["app", "native", ".zap"].map((path) =>
      rm(join(workspace, path), { recursive: true, force: true }),
    ),
  );
  const [{ default: handle }, { createNodeHandler }] = await Promise.all([
    import(pathToFileURL(join(artifact, "server/index.js")).href),
    import(
      pathToFileURL(join(root, "packages/client/dist/adapters/node.js")).href
    ),
  ]);
  server = createServer(createNodeHandler(handle));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Native deployment proof/);
  assert.match(html, /Native total:[\s\S]*42/);
  const flight = await fetch(base, { headers: { accept: "text/x-component" } });
  assert.match(flight.headers.get("content-type"), /^text\/x-component/);
  assert.match(await flight.text(), /native-total/);
  for (let i = 0; i < 8; i += 1) {
    const result = await fetch(`${base}/api/native`, {
      headers: { "x-request-id": `request-${i}`, authorization: "fixture" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      sum: 42,
      count: 2,
      requestId: `request-${i}`,
      authenticated: true,
    });
  }
  const failed = await fetch(`${base}/api/native?fail=1`);
  assert.equal(failed.status, 422);
  assert.deepEqual(await failed.json(), { error: "Values must be finite" });
  const bytes = await fetch(`${base}/api/bytes`, {
    method: "POST",
    body: new Uint8Array([0, 255, 128, 1]),
  });
  assert.deepEqual(
    new Uint8Array(await bytes.arrayBuffer()),
    new Uint8Array([1, 128, 255, 0]),
  );
  console.log(
    "Native production verification passed: relocated compiled React HTML/Flight and HTTP handlers call an in-process addon after application/native source removal; typed request context, errors, and binary values verified.",
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(workspace, { recursive: true, force: true });
}
