import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNodeHandler } from '../../packages/client/dist/adapters/node.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'zap-skew-'));
const servers = [];
const mutations = join(workspace, 'mutations.txt');
const previousMutationPath = process.env.ZAP_SKEW_MUTATIONS;
process.env.ZAP_SKEW_MUTATIONS = mutations;
const write = async (path, body) => { const file = join(workspace, path); await mkdir(dirname(file), {recursive:true}); await writeFile(file, body); };
const actions = version => `'use server';
import { appendFileSync } from 'node:fs';
export async function mutate(form) { appendFileSync(process.env.ZAP_SKEW_MUTATIONS, '${version}:plain\\n'); }
export async function bound(prefix,form) { appendFileSync(process.env.ZAP_SKEW_MUTATIONS, '${version}:'+prefix+'\\n'); }
export async function failString() { throw 'private-string-token'; }
export async function failObject() { throw {secret:'private-object-token'}; }
`;
const entities = { '&quot;':'"', '&amp;':'&', '&#x27;':"'", '&lt;':'<', '&gt;':'>' };
function forms(html) {
  return [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(([markup]) => {
    const data = new FormData();
    for (const input of markup.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/g)) {
      const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? '';
      data.append(input[1], value.replace(/&quot;|&amp;|&#x27;|&lt;|&gt;/g, entity => entities[entity]));
    }
    return data;
  });
}
async function build(name) {
  try { execFileSync(process.execPath, [join(root,'packages/client/dist/cli/index.js'),'build','--adapter','node'], {cwd:workspace,stdio:'pipe',timeout:120000}); }
  catch(error) { throw new Error(`Build ${name} failed: ${error.stdout}\n${error.stderr}`,{cause:error}); }
  const artifact = join(workspace,name);
  await rename(join(workspace,'.zap/output'),artifact);
  const {default:handler} = await import(pathToFileURL(join(artifact,'server/index.js')).href);
  const server = createServer(createNodeHandler(handler)); servers.push(server);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  await symlink(join(root,'node_modules'),join(workspace,'node_modules'));
  await write('package.json',JSON.stringify({type:'module'}));
  await write('app/layout.tsx','export default function Layout({children}){return <html><body>{children}</body></html>}');
  await write('app/page.tsx',`import {mutate,bound} from '../lib/actions'; export default function Page(){return <main><form action={mutate}><button>Plain</button></form><form action={bound.bind(null,'bound')}><button>Bound</button></form></main>}`);
  await write('app/errors/page.tsx',`import {failString,failObject} from '../../lib/actions'; export default function Page(){return <main><form action={failString}><button>String failure</button></form><form action={failObject}><button>Object failure</button></form></main>}`);
  await write('lib/actions.ts',actions('v1'));
  await write('mutations.txt','');
  const first = await build('build-one');
  const oldForms = forms(await(await fetch(first)).text());
  assert.equal(oldForms.length,2);
  for (const body of oldForms) {
    const response = await fetch(first,{method:'POST',headers:{origin:first},body});
    assert.equal(response.status,200); await response.arrayBuffer();
  }
  assert.equal(await readFile(mutations,'utf8'),'v1:plain\nv1:bound\n');
  await write('lib/actions.ts',actions('v2'));
  const second = await build('build-two');
  await Promise.all(['app','lib'].map(path=>rm(join(workspace,path),{recursive:true,force:true})));
  await write('mutations.txt','');
  for (const body of oldForms) {
    const response = await fetch(second,{method:'POST',headers:{origin:second},body});
    assert.ok(response.status>=400,'old progressive forms must reject before mutation'); await response.arrayBuffer();
    assert.equal(await readFile(mutations,'utf8'),'');
  }
  const newForms = forms(await(await fetch(second)).text());
  assert.equal(newForms.length,2);
  assert.notDeepEqual([...oldForms[0].keys()],[...newForms[0].keys()],'official action IDs must change between builds');
  for (const body of newForms) {
    const response = await fetch(second,{method:'POST',headers:{origin:second},body});
    assert.equal(response.status,200); await response.arrayBuffer();
  }
  assert.equal(await readFile(mutations,'utf8'),'v2:plain\nv2:bound\n');
  const failures = forms(await(await fetch(second+'/errors')).text());
  assert.equal(failures.length,2);
  for (const body of failures) {
    const id = [...body.keys()].find(key=>key.startsWith('$ACTION_ID_'))?.slice('$ACTION_ID_'.length);
    assert.ok(id,'rendered unbound action must expose a callable reference');
    const response = await fetch(second+'/errors',{method:'POST',headers:{origin:second,accept:'text/x-component','x-zap-action':id},body:'[]'});
    assert.equal(response.status,500);
    const wire = await response.text();
    assert.doesNotMatch(wire,/private-string-token|private-object-token/);
    assert.match(wire,/\"digest\":\"[0-9a-f]{8}-[0-9a-f-]{27}\"/);
  }
  console.log('Deployment skew verified across two real builds: old unhydrated plain/bound forms rejected before file-backed mutation; current forms execute; external lib/actions references versioned; source removed; thrown string/object action failures redacted in actual Flight.');
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  if(previousMutationPath===undefined) delete process.env.ZAP_SKEW_MUTATIONS; else process.env.ZAP_SKEW_MUTATIONS=previousMutationPath;
  await rm(workspace,{recursive:true,force:true});
}
