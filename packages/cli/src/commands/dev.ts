import chalk from 'chalk';
import { DevServer, DevServerConfig } from '@zapjs/dev-server';

export interface DevOptions {
  port?: string;
  vitePort?: string;
  open?: boolean;
  logLevel?: string;
  release?: boolean;
  skipBuild?: boolean;
}

/**
 * Start development server with hot reload
 *
 * Orchestrates:
 * - Rust backend compilation with file watching
 * - Vite frontend dev server
 * - Automatic TypeScript binding generation
 * - Hot reload signaling
 */
export async function devCommand(options: DevOptions): Promise<void> {
  const config: DevServerConfig = {
    projectDir: process.cwd(),
    rustPort: options.port ? parseInt(options.port, 10) : 3000,
    vitePort: options.vitePort ? parseInt(options.vitePort, 10) : 5173,
    logLevel: (options.logLevel as DevServerConfig['logLevel']) || 'info',
    release: options.release || false,
    skipInitialBuild: options.skipBuild || false,
    openBrowser: options.open !== false,
  };

  const server = new DevServer(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}
