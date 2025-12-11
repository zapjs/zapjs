import chalk from 'chalk';
import path from 'path';
import { existsSync } from 'fs';
import { DevServer, DevServerConfig } from '@zapjs/dev-server';

export interface DevOptions {
  port?: string;
  vitePort?: string;
  open?: boolean;
  logLevel?: string;
  release?: boolean;
  skipBuild?: boolean;
  binaryPath?: string;
  codegenBinaryPath?: string;
}

/**
 * Auto-detect pre-built binaries in bin/ directory
 */
function detectBinaries(projectDir: string): { binaryPath?: string; codegenBinaryPath?: string } {
  const binDir = path.join(projectDir, 'bin');
  const result: { binaryPath?: string; codegenBinaryPath?: string } = {};

  // Check for zap binary
  const zapBinary = path.join(binDir, 'zap');
  const zapBinaryExe = path.join(binDir, 'zap.exe');
  if (existsSync(zapBinary)) {
    result.binaryPath = zapBinary;
  } else if (existsSync(zapBinaryExe)) {
    result.binaryPath = zapBinaryExe;
  }

  // Check for zap-codegen binary
  const codegenBinary = path.join(binDir, 'zap-codegen');
  const codegenBinaryExe = path.join(binDir, 'zap-codegen.exe');
  if (existsSync(codegenBinary)) {
    result.codegenBinaryPath = codegenBinary;
  } else if (existsSync(codegenBinaryExe)) {
    result.codegenBinaryPath = codegenBinaryExe;
  }

  return result;
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
  const projectDir = process.cwd();

  // Auto-detect pre-built binaries if not explicitly provided
  const detectedBinaries = detectBinaries(projectDir);

  const config: DevServerConfig = {
    projectDir,
    rustPort: options.port ? parseInt(options.port, 10) : 3000,
    vitePort: options.vitePort ? parseInt(options.vitePort, 10) : 5173,
    logLevel: (options.logLevel as DevServerConfig['logLevel']) || 'info',
    release: options.release || false,
    skipInitialBuild: options.skipBuild || false,
    openBrowser: options.open !== false,
    binaryPath: options.binaryPath || detectedBinaries.binaryPath,
    codegenBinaryPath: options.codegenBinaryPath || detectedBinaries.codegenBinaryPath,
  };

  // Log if using pre-built binaries
  if (config.binaryPath) {
    console.log(chalk.blue(`Using pre-built binary: ${config.binaryPath}`));
  }

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
