import rsc from '@vitejs/plugin-rsc';
import react from '@vitejs/plugin-react';
import type { Plugin, InlineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { parse } from '@babel/parser';
import { scanGraph, type RouteGraph } from './graph.js';
import { limitFlight } from '../framework/stream.js';

export interface ZapCompilerOptions { command?: 'serve' | 'build'; nativeLoader?: string; outDir?: string }
const builtins = new Set(builtinModules.flatMap(id => [id, `node:${id}`]));
function frameworkFile(name: string) {
  const base = fileURLToPath(new URL(`../framework/${name}`, import.meta.url));
  return existsSync(base + '.tsx') ? base + '.tsx' : existsSync(base + '.ts') ? base + '.ts' : base + '.js';
}
function registry(graph: RouteGraph) {
  const loader = (file: string | undefined) => file ? `()=>import(${JSON.stringify(file)})` : 'undefined';
  const routes = graph.routes.map(({file,layers,...route}) => `{...${JSON.stringify(route)},load:${loader(file)},layers:[${layers.map(({key,layout,loading,error}) => `{key:${JSON.stringify(key)},layout:${loader(layout)},loading:${loader(loading)},error:${loader(error)}}`).join(',')}]}`);
  return `export const routes=[${routes.join(',')}];export const notFound=${loader(graph.notFound)};`;
}

/** One graph drives development, server rendering, browser references and deployment. */
export function createZapConfig(root: string, options: ZapCompilerOptions = {}): InlineConfig {
  root = resolve(root);
  const output = resolve(root, options.outDir ?? '.zap/output');
  let graph = scanGraph(root);
  const buildId = randomUUID();
  const applicationRoot = realpathSync(root);
  const frameworkRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const applicationModule = (id: string): boolean => {
    const file = id.split('?')[0];
    if (!/\.[cm]?[jt]sx?$/.test(file) || !existsSync(file)) return false;
    const canonical = realpathSync(file).replaceAll('\\', '/');
    return canonical.startsWith(applicationRoot + '/') && !canonical.startsWith(frameworkRoot + '/') && !/(?:^|\/)(?:node_modules|\.zap|\.vercel)\//.test(canonical);
  };
  const graphPlugin: Plugin = {
    name: 'zap:graph',
    enforce: 'pre',
    config(_config, environment) {
      if (environment.command === 'build') return { define: { 'process.env.NODE_ENV': JSON.stringify('production') } };
    },
    async resolveId(id, importer) {
      if (this.environment.name === 'client' && (id === 'zap:native' || ['@zap-js/client/server', '@zap-js/client/cache', '@zap-js/client/compiler'].includes(id) || /\/(?:framework\/(?:server|cache)|compiler\/)[^?]*\.[cm]?[jt]sx?(?:\?|$)/.test(id) || builtins.has(id) || /(?:^|\/)server-only(?:$|\/)|\.server\.[cm]?[jt]sx?$/.test(id))) {
        this.error(`Server-only import ${id} is reachable from browser module ${importer ?? '<entry>'}`);
      }
      if (id === 'zap:native') {
        if (this.environment.name !== 'rsc') this.error('Native code is restricted to server components, actions and route handlers');
        if (!options.nativeLoader) this.error('zap:native requires a compiled native/Cargo.toml module');
        // Preserve the loader's import.meta.url so its relative .node artifact survives deployment.
        return this.environment.mode === 'build' ? { id: 'zap:native', external: true } : resolve(options.nativeLoader!);
      }
      if (id === 'zap:routes' || id === 'zap:config' || id === 'zap:build') return '\0' + id;
      if (this.environment.mode === 'build' && !id.startsWith('\0')) {
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (resolved && !resolved.external && applicationModule(resolved.id) && !/[?&]__zap_build=/.test(resolved.id)) {
          return { ...resolved, id: resolved.id + (resolved.id.includes('?') ? '&' : '?') + '__zap_build=' + buildId };
        }
      }
    },
    transform(code, id) {
      if (this.environment.mode !== 'build' || !/\.[cm]?[jt]sx?(?:\?|$)/.test(id) || applicationModule(id) || !/['"]use server['"]/.test(code)) return;
      const syntax = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
      const hasDirective = (node: any): boolean => {
        if (!node || typeof node !== 'object') return false;
        if (node.type === 'Directive' && node.value?.value === 'use server') return true;
        return Object.entries(node).some(([key,value]) => key !== 'loc' && key !== 'comments' && (Array.isArray(value) ? value.some(hasDirective) : hasDirective(value)));
      };
      if (hasDirective(syntax.program)) this.error(`Server actions must be defined inside the application root for deployment versioning: ${id}`);
    },
    renderChunk(code, chunk) {
      if (!options.nativeLoader || !code.includes('zap:native')) return;
      // External module paths must be relative to each emitted chunk, not the
      // source module or build machine. This also survives output relocation.
      let path = relative(dirname(join(this.environment.config.build.outDir, chunk.fileName)), resolve(options.nativeLoader)).replaceAll('\\', '/');
      if (!path.startsWith('.')) path = './' + path;
      const replacements: { start: number; end: number }[] = [];
      const visit = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value === 'zap:native') replacements.push(node.source);
        if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments[0]?.value === 'zap:native') replacements.push(node.arguments[0]);
        for (const [key, value] of Object.entries(node)) {
          if (key === 'loc' || key === 'tokens' || key === 'comments') continue;
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === 'object') visit(value);
        }
      };
      visit(parse(code, { sourceType: 'module' }).program);
      for (const replacement of replacements.sort((a,b) => b.start-a.start)) code = code.slice(0, replacement.start) + JSON.stringify(path) + code.slice(replacement.end);
      return { code, map: null };
    },
    load(id) {
      if (id === '\0zap:build') return `export default ${JSON.stringify(buildId)};`;
      if (id === '\0zap:routes') return registry(graph);
      if (id === '\0zap:config') return graph.runtimeConfig ? `export {default} from ${JSON.stringify(graph.runtimeConfig)};` : 'export default {};';
    },
    configureServer(server) {
      server.watcher.add(join(root, 'app'));
      const update = (file: string) => {
        if (!file.startsWith(join(root, 'app') + '/') && !file.startsWith(join(root, 'zap.runtime.'))) return;
        try {
          graph = scanGraph(root);
          for (const env of Object.values(server.environments)) {
            for (const id of ['\0zap:routes', '\0zap:config']) {
              const module = env.moduleGraph.getModuleById(id);
              if (module) env.moduleGraph.invalidateModule(module);
            }
          }
          server.environments.client.hot.send({ type: 'custom', event: 'rsc:update', data: {} });
        } catch (error) {
          server.ws.send({ type: 'error', err: { message: String(error), stack: '' } });
        }
      };
      server.watcher.on('add', update).on('unlink', update);
      server.httpServer?.once('close', () => { server.watcher.off('add', update).off('unlink', update); });
    },
    buildApp: {
      order: 'post',
      async handler() {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }));
        const entry = await import(pathToFileURL(join(output, 'server/index.js')).href + '?build=' + Date.now());
        const prerender = [];
        for (const path of await entry.prerenderEntries()) {
          const id = createHash('sha256').update(path).digest('hex').slice(0, 24);
          const files = { html: `__zap/prerender/${id}.html`, flight: `__zap/prerender/${id}.rsc` };
          const controller = new AbortController();
          const errors: unknown[] = [];
          try {
            let flight: Promise<ArrayBuffer> | undefined;
            const response: Response = await entry.default(new Request(new URL(path, 'http://zap.build'), { signal: controller.signal }), {
              prerender: true,
              onError: (error: unknown) => errors.push(error),
              onFlight: (stream: ReadableStream<Uint8Array>) => {
                // This capture is a sibling of SSR's tee, so it needs its own
                // limit. Observe rejection immediately while SSR is starting.
                flight = new Response(limitFlight(stream, { signal: controller.signal })).arrayBuffer().catch(error => {
                  errors.push(error);
                  return new ArrayBuffer(0);
                });
              },
            });
            if (response.status !== 200 || response.headers.has('set-cookie') || /private|no-store/.test(response.headers.get('cache-control') ?? '')) throw new Error(`Cannot prerender ${path}: status ${response.status} or private response`);
            if (!flight) throw new Error(`Prerender ${path} did not produce a Flight payload`);
            const [htmlBody, flightBody] = await Promise.all([response.arrayBuffer(), flight]);
            if (errors.length) throw new Error(`Cannot prerender ${path}: ${errors.map(String).join('; ')}`);
            const status = response.status;
            const headers = Object.fromEntries(response.headers);
            for (const [format, body] of [['html', htmlBody], ['flight', flightBody]] as const) {
              const file = join(output, 'static', files[format]);
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, Buffer.from(body));
            }
            prerender.push({ path, ...files, status, headers });
          } finally {
            // A failed response/serializer must stop every sibling render and
            // capture branch, including producers with pending async work.
            controller.abort();
          }
        }
        writeFileSync(join(output, 'manifest.json'), JSON.stringify({
          version: 1, buildId, framework: 'zap', react: '19.3.0', runtime: 'node', server: 'server/index.js', static: 'static',
          routes: graph.routes.map(({file,layers,...route}) => ({ ...route, layers: layers.map(layer => layer.key) })),
          prerender,
          capabilities: { rsc: true, streaming: true, serverActions: true, native: !!options.nativeLoader },
        }, null, 2));
      },
    },
  };
  const environment = (name: 'rsc' | 'ssr' | 'client', directory: string) => ({
    build: { outDir: join(output, directory), emptyOutDir: true, sourcemap: false, rollupOptions: { input: { index: frameworkFile(`entry.${name === 'client' ? 'browser' : name}`) } } },
  });
  return {
    root, configFile: false, appType: 'custom',
    plugins: [graphPlugin, rsc(), react()],
    resolve: { dedupe: ['react', 'react-dom'], alias: [
      { find: /^@zap-js\/client$/, replacement: frameworkFile('client') },
      { find: /^@zap-js\/client\/client$/, replacement: frameworkFile('client') },
      { find: /^@zap-js\/client\/server$/, replacement: frameworkFile('server') },
      { find: /^@zap-js\/client\/cache$/, replacement: frameworkFile('cache') },
    ] },
    server: { fs: { allow: [root, resolve(dirname(fileURLToPath(import.meta.url)), '..')] } },
    environments: { rsc: environment('rsc', 'server'), ssr: environment('ssr', 'ssr'), client: environment('client', 'static') },
  };
}
export { scanGraph } from './graph.js';
