import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lookup } from 'mime-types';
import { Readable } from 'node:stream';
import { createNodeHandler, type WebHandler } from './node.js';
import { acceptsFlight } from '../framework/http.js';

/** Local inspection of the generated artifact, never a production process requirement. */
export async function previewOutput(outputDir: string, options: { port?: number; host?: string } = {}) {
  const output = resolve(outputDir);
  const module = await import(pathToFileURL(resolve(output, 'server/index.js')).href);
  const handler: WebHandler = module.default;
  const staticRoot = await realpath(resolve(output, 'static'));
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  const prerender = new Map<string, { html: string; flight: string; status: number; headers: Record<string, string> }>((manifest.prerender || []).map((entry: { path: string }) => [entry.path, entry]));
  const dispatch: WebHandler = async request => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch { return new Response('Bad Request', { status: 400 }); }
      const entry = prerender.get(new URL(request.url).pathname);
      const flight = acceptsFlight(request.headers.get('accept'));
      const candidate = entry ? resolve(staticRoot, flight ? entry.flight : entry.html) : resolve(staticRoot, `.${pathname}`);
      if (candidate.startsWith(`${staticRoot}${sep}`)) {
        try {
          const canonical = await realpath(candidate);
          if (canonical.startsWith(`${staticRoot}${sep}`) && (await stat(canonical)).isFile()) {
            const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(canonical)) as ReadableStream<Uint8Array>;
            const headers = new Headers({
              'content-type': flight && entry ? 'text/x-component' : lookup(canonical) || 'application/octet-stream',
              ...(entry?.headers || {}), ...(entry ? { vary: [...new Set([...(entry.headers.vary || '').split(',').map(value => value.trim()).filter(Boolean), 'Accept'])].join(', '), ...(flight ? { 'content-type': 'text/x-component' } : {}) } : {}),
            });
            headers.delete('content-length');
            return new Response(body, { status: entry?.status || 200, headers });
          }
        } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
      }
    }
    return handler(request);
  };
  const server = createServer(createNodeHandler(dispatch));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3000, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
