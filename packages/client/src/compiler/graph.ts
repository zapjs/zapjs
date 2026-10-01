import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';

export type Segment = { kind: 'static' | 'dynamic' | 'catchall' | 'optional'; value: string };
export interface RouteLayer { key: string; layout?: string; loading?: string; error?: string }
export interface Route { id: string; path: string; kind: 'page' | 'route'; file: string; segments: Segment[]; layers: RouteLayer[]; prerender: boolean }
export interface RouteGraph { version: 1; root: string; routes: Route[]; notFound?: string; runtimeConfig?: string }
const extensions = ['tsx', 'ts', 'jsx', 'js'];
function convention(dir: string, name: string): string | undefined {
  const files = extensions.map(ext => join(dir, `${name}.${ext}`)).filter(existsSync);
  if (files.length > 1) throw new Error(`Ambiguous ${name} modules: ${files.join(', ')}`);
  return files[0];
}
export function scanGraph(root: string): RouteGraph {
  const app = join(root, 'app');
  if (!existsSync(app)) throw new Error(`Missing app directory: ${app}`);
  const routes: Route[] = [];
  function visit(dir: string, segments: Segment[], parents: RouteLayer[]) {
    const layer: RouteLayer = { key: relative(app, dir) || '/', layout: convention(dir, 'layout'), loading: convention(dir, 'loading'), error: convention(dir, 'error') };
    if (layer.error && !parse(readFileSync(layer.error, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program.directives.some(item => item.value.value === 'use client')) throw new Error(`${layer.error} must declare "use client"`);
    const layers = [...parents, layer];
    for (const kind of ['page', 'route'] as const) {
      const file = convention(dir, kind);
      if (file) {
        const path = '/' + segments.map(s => s.kind === 'static' ? s.value : s.kind === 'dynamic' ? `[${s.value}]` : s.kind === 'catchall' ? `[...${s.value}]` : `[[...${s.value}]]`).join('/');
        const syntax = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
        const prerender = syntax.program.body.some(item => item.type === 'ExportNamedDeclaration' && item.declaration?.type === 'VariableDeclaration' && item.declaration.declarations.some(declaration => declaration.id.type === 'Identifier' && declaration.id.name === 'prerender' && declaration.init?.type === 'BooleanLiteral' && declaration.init.value));
        routes.push({ prerender, id: relative(app, file).replaceAll('\\', '/'), path, kind, file, segments, layers });
      }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const name = entry.name;
      if (name.startsWith('@') || /^\(\./.test(name)) throw new Error(`Parallel and intercepting route segments are unsupported: ${name}`);
      if (/^\([^()]+\)$/.test(name)) { visit(join(dir, name), segments, layers); continue; }
      if (segments.some(s => s.kind === 'catchall' || s.kind === 'optional')) throw new Error(`Catch-all segment must be last: ${join(dir, name)}`);
      const optional = /^\[\[\.\.\.(\w+)\]\]$/.exec(name);
      const catchall = /^\[\.\.\.(\w+)\]$/.exec(name);
      const dynamic = /^\[(\w+)\]$/.exec(name);
      const segment: Segment = optional ? { kind: 'optional', value: optional[1] } : catchall ? {kind:'catchall',value:catchall[1]} : dynamic ? {kind:'dynamic',value:dynamic[1]} : {kind:'static',value:name};
      if (segment.kind === 'static' && /[\[\]]/.test(name)) throw new Error(`Invalid route segment: ${name}`);
      if (segment.kind !== 'static' && segments.some(s => s.kind !== 'static' && s.value === segment.value)) throw new Error(`Duplicate route parameter ${segment.value}`);
      visit(join(dir, name), [...segments, segment], layers);
    }
  }
  visit(app, [], []);
  const signatures = new Map<string, string>();
  for (const route of routes) {
    if (route.segments.every(segment => segment.kind === 'static')) {
      const asset = join(root, 'public', ...route.segments.map(segment => segment.value));
      if (existsSync(asset) && statSync(asset).isFile()) throw new Error(`Public asset conflicts with route ${route.id}: ${asset}`);
    }
    const signature = route.segments.map(s => s.kind === 'static' ? s.value : ':' + s.kind).join('/');
    if (signatures.has(signature)) throw new Error(`Conflicting routes: ${signatures.get(signature)} and ${route.id}`);
    signatures.set(signature, route.id);
  }
  const rank = { static: 0, dynamic: 1, catchall: 2, optional: 3 };
  routes.sort((a,b) => {
    for (let i=0; i<Math.max(a.segments.length,b.segments.length); i++) {
      if (!a.segments[i]) return -1;
      if (!b.segments[i]) return 1;
      const delta = rank[a.segments[i].kind] - rank[b.segments[i].kind];
      if (delta) return delta;
    }
    return a.path.localeCompare(b.path);
  });
  if (routes.some(route => route.kind === 'page') && !convention(app, 'layout')) throw new Error('Pages require app/layout.tsx with html and body elements');
  return { version: 1, root, routes, notFound: convention(app, 'not-found'), runtimeConfig: convention(root, 'zap.runtime') };
}
