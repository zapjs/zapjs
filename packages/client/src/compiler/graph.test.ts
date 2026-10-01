import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanGraph } from './graph.js';
import { matchRoute } from '../framework/match.js';
const roots: string[] = [];
function fixture(files: Record<string,string>) {
  const root = mkdtempSync(join(tmpdir(), 'zap-graph-')); roots.push(root);
  files = { 'layout.tsx': 'export default function Layout({children}) {return <html><body>{children}</body></html>}', ...files };
  for (const [name, body] of Object.entries(files)) { const file = join(root, 'app', name); mkdirSync(dirname(file), {recursive:true}); writeFileSync(file, body); }
  return root;
}
afterEach(() => { for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const page = 'export default function Page(){ return null }';
test('one graph composes route groups, nested layouts and deterministic segment precedence', () => {
  const graph = scanGraph(fixture({ 'layout.tsx':page, '(shop)/layout.tsx':page, '(shop)/products/layout.tsx':page, '(shop)/products/[id]/page.tsx':page, '(shop)/products/new/page.tsx':page, 'docs/[...path]/page.tsx':page, 'archive/[[...path]]/page.tsx':page }));
  const match = matchRoute(graph.routes, '/products/new')!;
  expect(match.route.id).toContain('new/page');
  expect(matchRoute(graph.routes, '/products/42')!.params).toEqual({id:'42'});
  expect(matchRoute(graph.routes, '/products/42')!.route.layers.filter(layer=>layer.layout)).toHaveLength(3);
  expect(matchRoute(graph.routes, '/docs/a/b')!.params).toEqual({path:['a','b']});
  expect(matchRoute(graph.routes, '/docs')).toBeUndefined();
  expect(matchRoute(graph.routes, '/archive')!.params).toEqual({path:[]});
});
test('rejects ambiguous patterns and page/handler collisions', () => {
  expect(()=>scanGraph(fixture({'[id]/page.tsx':page,'[name]/page.tsx':page}))).toThrow('Conflicting');
  expect(()=>scanGraph(fixture({'page.tsx':page,'route.ts':'export function GET(){}'}))).toThrow('Conflicting');
});
test('rejects invalid catchall children and repeated parameter names', () => {
  expect(()=>scanGraph(fixture({'[...all]/nested/page.tsx':page}))).toThrow('must be last');
  expect(()=>scanGraph(fixture({'[id]/[id]/page.tsx':page}))).toThrow('Duplicate');
});
test('error components require a real client directive, with comments allowed', () => {
  expect(()=>scanGraph(fixture({'page.tsx':page,'error.tsx':page}))).toThrow('use client');
  expect(scanGraph(fixture({'page.tsx':page,'error.tsx':'// explanation\n"use client"; '+page})).routes[0].layers[0].error).toBeDefined();
});
test('prerender is explicit literal build metadata', () => {
  const graph = scanGraph(fixture({'page.tsx':'export const prerender = true; '+page,'live/page.tsx':page}));
  expect(graph.routes.find(route=>route.path==='/')!.prerender).toBe(true);
  expect(graph.routes.find(route=>route.path==='/live')!.prerender).toBe(false);
});
test('malformed encodings and encoded separators never change route meaning', () => {
  const routes = scanGraph(fixture({'[id]/page.tsx':page})).routes;
  for (const path of ['/%E0%A4%A','/a%2Fb','/%2e%2e','/a%5Cb']) expect(matchRoute(routes,path)).toBeUndefined();
});

test('public files cannot silently shadow exact application routes', () => {
  const root = fixture({'about/page.tsx':page});
  mkdirSync(join(root,'public'));
  writeFileSync(join(root,'public','about'),'static asset');
  expect(()=>scanGraph(root)).toThrow('Public asset conflicts with route');
});
