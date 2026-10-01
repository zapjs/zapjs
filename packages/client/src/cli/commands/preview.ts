import { resolve } from 'node:path';
import { previewOutput } from '../../adapters/preview.js';
import { cliLogger } from '../utils/logger.js';

export async function previewCommand(options: { port?: string; host?: string }): Promise<void> {
  const port = Number(options.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const host = options.host || '127.0.0.1';
  process.env.NODE_ENV = 'production';
  const server = await previewOutput(resolve('.zap/output'), { port, host });
  const shutdown = () => {
    server.close();
    server.closeIdleConnections();
    const timeout = setTimeout(() => server.closeAllConnections(), 3000);
    timeout.unref();
    server.once('close', () => clearTimeout(timeout));
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  cliLogger.success(`Build preview: http://${host}:${port}`);
}
