import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'zap-prerender-negative-'));
const cases = [
  {
    name:'cross-route publication',
    files:{'[id]/page.tsx':`export const prerender=true; export function generateStaticParams(){return [{id:'admin'}]} export default function Page(){return <h1>public</h1>}`, 'admin/page.tsx':`export default function Admin(){return <h1>Never opted in</h1>}`},
    reason:/Cannot prerender \/admin.*matches admin\/page/,
  },
  {
    name:'private request metadata',
    files:{'page.tsx':`import {headers} from '@zap-js/client/server'; export const prerender=true; export default function Page(){return <h1>{headers().get('cookie')}</h1>}`},
    reason:/Cannot prerender|Request metadata cannot be accessed while prerendering/,
  },
  {
    name:'late streamed component failure',
    files:{'page.tsx':`import {Suspense} from 'react'; export const prerender=true; async function Late(){await new Promise(resolve=>setTimeout(resolve,20));throw new Error('late-build-failure')} export default function Page(){return <main>Shell<Suspense fallback={<p>loading</p>}><Late/></Suspense></main>}`},
    reason:/Cannot prerender .*late-build-failure/,
  },
  {
    name:'oversized captured Flight',
    files:{'page.tsx':`export const prerender=true; export default function Page(){return <main>{'x'.repeat(9*1024*1024)}</main>}`},
    reason:/Flight.*(?:limit|exceed|large)|Cannot prerender/i,
  },
];
try {
  await symlink(join(root,'node_modules'),join(workspace,'node_modules'));
  await writeFile(join(workspace,'package.json'),JSON.stringify({type:'module'}));
  for(const scenario of cases) {
    await rm(join(workspace,'app'),{recursive:true,force:true});
    const files={'layout.tsx':'export default function Layout({children}){return <html><body>{children}</body></html>}',...scenario.files};
    for(const [path,body] of Object.entries(files)){const file=join(workspace,'app',path);await mkdir(dirname(file),{recursive:true});await writeFile(file,body);}
    let failure;
    try {execFileSync(process.execPath,[join(root,'packages/client/dist/cli/index.js'),'build','--adapter','node'],{cwd:workspace,stdio:'pipe',timeout:120000,maxBuffer:8*1024*1024});}
    catch(error){failure=error;}
    assert.ok(failure,`${scenario.name} must fail the real build`);
    assert.notEqual(failure.signal,'SIGTERM',`${scenario.name} must terminate itself, not hang until test timeout`);
    assert.match(String(failure.stdout)+'\n'+String(failure.stderr),scenario.reason,scenario.name);
    await assert.rejects(access(join(workspace,'.zap/output/manifest.json')),`${scenario.name} must not publish a completed manifest`);
    console.log(`Prerender rejection verified: ${scenario.name}`);
  }
} finally {await rm(workspace,{recursive:true,force:true});}
