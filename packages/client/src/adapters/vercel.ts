import { nodeFileTrace } from '@vercel/nft';
import { copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VercelOptions { outputDir?: string; nativeTarget?: string; }

/** Lower a compiled Zap output into Vercel's Build Output API v3. */
export async function emitVercelOutput(root: string, options: VercelOptions = {}): Promise<string> {
  const output = resolve(root, options.outputDir || '.zap/output');
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const nativeTarget = options.nativeTarget ?? manifest.native?.target;
  if (manifest.capabilities?.native && !nativeTarget) throw new Error('Native deployment metadata is missing its target');
  if (nativeTarget && nativeTarget !== 'x86_64-unknown-linux-gnu' && nativeTarget !== 'aarch64-unknown-linux-gnu') {
    throw new Error(`Native target ${nativeTarget} is not supported by the Vercel Node runtime; build for Linux GNU`);
  }
  const serverEntry = join(output, 'server', 'index.js');
  await stat(serverEntry);
  const adapterEntry = fileURLToPath(new URL('./node.js', import.meta.url));
  // Tracing from the filesystem root preserves relative package imports across
  // workspaces and symlinked package managers; only the dependency closure is copied.
  const traceBase = parse(await realpath(root)).root;
  const entries = [adapterEntry];
  for (const directory of ['server', 'ssr', 'native']) {
    entries.push(...await emittedModules(join(output, directory)));
  }
  const trace = await nodeFileTrace(entries, { base: traceBase, processCwd: root });
  const unresolved = [...trace.warnings].filter(warning => /Failed to resolve dependency|Cannot resolve/.test(warning.message));
  if (unresolved.length) throw new Error(`Unresolved deployment dependencies:\n${unresolved.map(warning => warning.message).join('\n')}`);
  const target = join(root, '.vercel', 'output');
  const functionDir = join(target, 'functions', 'zap.func');
  await rm(target, { recursive: true, force: true });
  await mkdir(functionDir, { recursive: true });
  const destination = (source: string) => join(functionDir, 'files', relative(traceBase, source));
  for (const file of trace.fileList) {
    const source = resolve(traceBase, file);
    const dest = destination(source);
    await mkdir(dirname(dest), { recursive: true });
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(source);
      await symlink(relative(dirname(dest), destination(resolved)), dest);
    } else if (info.isFile()) await copyFile(source, dest);
  }
  // Copy all compiled server chunks and native libraries, including files reached
  // by dynamic RSC loading that cannot be inferred from a single static import.
  for (const directory of ['server', 'ssr', 'native']) {
    const source = join(output, directory);
    try { await cp(source, destination(source), { recursive: true, dereference: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const importPath = (file: string) => `./${relative(functionDir, destination(file)).split('\\').join('/')}`;
  await writeFile(join(functionDir, 'index.mjs'), `import handler from ${JSON.stringify(importPath(serverEntry))};\nimport { createNodeHandler } from ${JSON.stringify(importPath(adapterEntry))};\nexport default createNodeHandler(handler, { trustProxy: true });\n`);
  await writeFile(join(functionDir, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs',
    architecture: nativeTarget?.startsWith('aarch64') ? 'arm64' : 'x86_64',
    supportsResponseStreaming: true, shouldAddHelpers: false, environment: { NODE_ENV: 'production' },
  }, null, 2));
  await writeFile(join(functionDir, 'zap-manifest.json'), JSON.stringify(manifest, null, 2));
  await cp(join(output, 'static'), join(target, 'static'), { recursive: true });
  const prerenderRoutes = (manifest.prerender || []).flatMap((entry: { path: string; html: string; flight: string; status: number; headers: Record<string, string> }) => {
    const src = `^${entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const headers = { ...entry.headers, vary: [...new Set([...(entry.headers.vary || '').split(',').map(value => value.trim()).filter(Boolean), 'Accept'])].join(', ') };
    delete (headers as Record<string, string>)['content-length'];
    // The CDN's routing language cannot implement weighted media negotiation.
    // Keep the common navigation header static and delegate ambiguous headers
    // to the runtime, which uses the same parser as local preview.
    const flightType = '[tT][eE][xX][tT]/[xX]-[cC][oO][mM][pP][oO][nN][eE][nN][tT]';
    return [
      { src, methods: ['GET', 'HEAD'], has: [{ type: 'header', key: 'accept', value: `^\\s*${flightType}\\s*$` }], dest: `/${entry.flight}`, status: entry.status, headers: { ...headers, 'content-type': 'text/x-component' } },
      { src, methods: ['GET', 'HEAD'], has: [{ type: 'header', key: 'accept', value: `.*${flightType}.*` }], dest: '/zap' },
      { src, methods: ['GET', 'HEAD'], dest: `/${entry.html}`, status: entry.status, headers },
    ];
  });
  await writeFile(join(target, 'config.json'), JSON.stringify({
    version: 3,
    routes: [...prerenderRoutes, { handle: 'filesystem' }, { src: '/(.*)', dest: '/zap' }],
  }, null, 2));
  return target;
}

async function emittedModules(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const modules: string[] = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await emittedModules(file));
    else if (/\.[cm]?js$/.test(entry.name)) modules.push(file);
  }
  return modules;
}
