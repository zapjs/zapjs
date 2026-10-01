import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { createZapConfig } from '../compiler/config.js';
import { buildNative } from '../native/build.js';

/** Runs only in development. Restarting this process releases loaded native addons. */
export async function startDevelopment(root: string, options: { port: number; host: string }) {
  const controller = new AbortController();
  let server: ViteDevServer | undefined;
  const stop = async () => {
    controller.abort();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await server?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const native = await buildNative(root, { release: false, outDir: resolve(root, '.zap/native'), signal: controller.signal });
    if (controller.signal.aborted) return;
    const config = createZapConfig(root, { command: 'serve', nativeLoader: native?.loaderPath });
    config.server = { ...config.server, port: options.port, host: options.host, strictPort: true };
    server = await createServer(config);
    if (controller.signal.aborted) { await server.close(); return; }
    await server.listen();
    server.printUrls();
    return server;
  } catch (error) {
    const interrupted = controller.signal.aborted;
    await stop();
    if (!interrupted) throw error;
  }
}
