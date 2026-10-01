#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createZapConfig } from '../../packages/client/dist/compiler/config.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'zap-development-'));
let server;
const write = async (path, body) => { const file = join(workspace, path); await mkdir(dirname(file), {recursive:true}); await writeFile(file, body); };
const page = value => `export default function Page(){return <h1>${value}</h1>}`;
try {
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'));
  await write('package.json', JSON.stringify({type:'module',dependencies:{'@zap-js/client':'0.3.0',react:'19.3.0','react-dom':'19.3.0'}}));
  await write('app/layout.tsx', 'export default function Layout({children}) {return <html><body><header>Layout retained</header>{children}</body></html>}');
  await write('app/page.tsx', page('Initial dev output'));
  const config = createZapConfig(workspace, {command:'serve'});
  config.server = {...config.server, host:'127.0.0.1',port:0};
  config.logLevel = 'error';
  server = await createServer(config);
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const matches = async (path, expected, status=200) => {
    const response = await fetch(new URL(path,base));
    assert.equal(response.status,status);
    const html = await response.text();
    assert.match(html,expected);
  };
  const eventually = async check => {
    const deadline=Date.now()+15000;
    let last;
    while(Date.now()<deadline) {
      try { await check(); return; } catch(error) { last=error; }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw last;
  };
  await matches('/',/Initial dev output/);
  await write('app/page.tsx',page('Edited dev output'));
  await eventually(()=>matches('/',/Edited dev output/));
  await write('app/new/[id]/page.tsx','export default function Page({params}) {return <h1>Added route {params.id}</h1>}');
  await eventually(()=>matches('/new/42',/Added route <!-- -->42/));
  await rm(join(workspace,'app/new/[id]/page.tsx'));
  await eventually(()=>matches('/new/42',/Page not found/,404));
  await write('app/api/value/route.ts','export function GET(){return Response.json({value:42})}');
  await eventually(async()=>assert.deepEqual(await(await fetch(new URL('/api/value',base))).json(),{value:42}));
  const flight=await fetch(base,{headers:{accept:'text/x-component'}});
  assert.equal(flight.status,200);
  assert.match(flight.headers.get('content-type'),/text\/x-component/);
  assert.match(await flight.text(),/Edited dev output/);
  console.log('Development verification passed: real RSC/SSR server, source edit HMR, add/remove dynamic route graph, added API route, Flight response.');
} finally {
  await server?.close();
  await rm(workspace,{recursive:true,force:true});
}
