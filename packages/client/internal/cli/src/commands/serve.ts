import { ChildProcess, spawn } from 'child_process';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { findAvailablePort } from '../utils/port-finder.js';
import { IpcServer, ProcessManager, ZapConfig, RouteConfig } from '@zapjs/runtime';

export interface ServeOptions {
  port?: string;
  host?: string;
  config?: string;
  workers?: string;
  logLevel?: string;
}

interface ProductionConfig {
  server: {
    host: string;
    port: number;
  };
  static?: {
    prefix: string;
    directory: string;
  } | null;
  logging?: {
    level: string;
    format: string;
  };
}

interface RouteManifest {
  routes: Array<{ filePath: string; urlPath: string }>;
  apiRoutes: Array<{
    filePath: string;
    relativePath: string;
    urlPath: string;
    type: string;
    params: Array<{ name: string; index: number; catchAll: boolean }>;
    methods?: string[];
    isIndex: boolean;
  }>;
}

// Register tsx loader for TypeScript imports
let tsxRegistered = false;
async function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return;
  try {
    const tsx = await import('tsx/esm/api');
    tsx.register();
    tsxRegistered = true;
  } catch {
    // tsx not available, try without it
  }
}

/**
 * Run production server
 *
 * This command now properly:
 * 1. Starts an IPC server for TypeScript route handlers
 * 2. Loads and registers route handlers from the route manifest
 * 3. Passes proper --config and --socket args to the Rust binary
 * 4. Coordinates both processes for graceful shutdown
 */
export async function serveCommand(options: ServeOptions): Promise<void> {
  const spinner = ora();

  try {
    console.log(chalk.cyan('\n⚡ Zap Production Server\n'));

    // Determine working directory (dist or current)
    const distDir = resolve('./dist');
    const workDir = existsSync(join(distDir, 'bin', 'zap')) ? distDir : process.cwd();
    let binPath = join(workDir, 'bin', 'zap');

    // Check for binary in multiple locations
    if (!existsSync(binPath)) {
      const altPaths = [
        join(process.cwd(), 'bin', 'zap'),
        join(process.cwd(), 'target', 'release', 'zap'),
      ];

      for (const altPath of altPaths) {
        if (existsSync(altPath)) {
          binPath = altPath;
          break;
        }
      }
    }

    if (!existsSync(binPath)) {
      console.error(chalk.red('\nError: No production binary found.'));
      console.error(chalk.gray('Run `zap build` first to create a production build.\n'));
      process.exit(1);
    }

    // Load production config if available
    let prodConfig: ProductionConfig | null = null;
    const configPath = options.config || join(workDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        prodConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        spinner.succeed(`Loaded config from ${configPath}`);
      } catch {
        spinner.warn('Failed to parse config.json, using defaults');
      }
    }

    await runProductionServer(binPath, options, spinner, workDir, prodConfig);

  } catch (error) {
    spinner.fail('Failed to start server');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}

async function runProductionServer(
  binPath: string,
  options: ServeOptions,
  spinner: Ora,
  workDir: string,
  prodConfig?: ProductionConfig | null
): Promise<void> {
  const port = parseInt(options.port || prodConfig?.server?.port?.toString() || '3000');
  const host = options.host || prodConfig?.server?.host || '0.0.0.0';
  const logLevel = options.logLevel || prodConfig?.logging?.level || 'info';

  // Find available port
  spinner.start(`Checking port ${port}...`);
  const availablePort = await findAvailablePort(port);

  if (availablePort !== port) {
    spinner.warn(`Port ${port} in use, using ${availablePort}`);
  } else {
    spinner.succeed(`Port ${availablePort} available`);
  }

  // Generate unique socket path
  const socketPath = join(tmpdir(), `zap-prod-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

  // Start IPC server for TypeScript handlers
  spinner.start('Starting IPC server...');
  const ipcServer = new IpcServer(socketPath);
  await ipcServer.start();
  spinner.succeed('IPC server started');

  // Load and register route handlers
  const routes = await loadRouteHandlers(ipcServer, workDir, spinner);

  // Build Rust server configuration
  const zapConfig: ZapConfig = {
    port: availablePort,
    hostname: host,
    ipc_socket_path: socketPath,
    routes,
    static_files: prodConfig?.static ? [{
      prefix: prodConfig.static.prefix,
      directory: prodConfig.static.directory,
    }] : [],
    middleware: {
      enable_cors: true,
      enable_logging: true,
      enable_compression: true,
    },
    health_check_path: '/health',
  };

  // Also check for static directory in workDir
  const staticDir = join(workDir, 'static');
  if (existsSync(staticDir) && zapConfig.static_files.length === 0) {
    zapConfig.static_files.push({
      prefix: '/',
      directory: staticDir,
    });
  }

  // Write config to temp file
  const tempConfigPath = join(tmpdir(), `zap-config-${Date.now()}.json`);
  writeFileSync(tempConfigPath, JSON.stringify(zapConfig, null, 2));

  // Start Rust server
  spinner.start('Starting Rust HTTP server...');

  const rustProcess: ChildProcess = spawn(binPath, [
    '--config', tempConfigPath,
    '--socket', socketPath,
    '--log-level', logLevel,
  ], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: availablePort.toString(),
      HOST: host,
      RUST_LOG: logLevel,
      ZAP_ENV: 'production',
    },
  });

  let started = false;

  rustProcess.stdout?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started && (output.includes('listening') || output.includes('Server'))) {
      started = true;
      spinner.succeed('Server started');
      printServerInfo(host, availablePort, workDir, prodConfig, routes.length);
    }
    if (started) {
      process.stdout.write(chalk.gray(output));
    }
  });

  rustProcess.stderr?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started) {
      // Don't fail immediately on stderr - Rust logs info to stderr sometimes
      if (output.includes('error') || output.includes('Error')) {
        spinner.fail('Server failed to start');
        console.error(chalk.red(output));
        cleanup(ipcServer, tempConfigPath);
        process.exit(1);
      }
    }
    process.stderr.write(chalk.yellow(output));
  });

  rustProcess.on('error', (err: Error) => {
    spinner.fail(`Failed to start: ${err.message}`);
    cleanup(ipcServer, tempConfigPath);
    process.exit(1);
  });

  rustProcess.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(chalk.red(`\nServer exited with code ${code}\n`));
      cleanup(ipcServer, tempConfigPath);
      process.exit(code);
    }
  });

  // If server doesn't output "listening", assume it started after a delay
  setTimeout(() => {
    if (!started) {
      started = true;
      spinner.succeed('Server started');
      printServerInfo(host, availablePort, workDir, prodConfig, routes.length);
    }
  }, 3000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.yellow('\n\nShutting down...'));

    // Kill Rust process
    if (!rustProcess.killed) {
      rustProcess.kill('SIGTERM');
    }

    // Stop IPC server
    await ipcServer.stop();

    // Cleanup temp config
    cleanup(null, tempConfigPath);

    // Force kill after timeout
    setTimeout(() => {
      if (!rustProcess.killed) {
        rustProcess.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Load TypeScript route handlers from route manifest
 */
async function loadRouteHandlers(
  ipcServer: IpcServer,
  workDir: string,
  spinner: Ora
): Promise<RouteConfig[]> {
  const routes: RouteConfig[] = [];

  // Try multiple manifest locations
  const manifestPaths = [
    join(workDir, 'src', 'generated', 'routeManifest.json'),
    join(process.cwd(), 'src', 'generated', 'routeManifest.json'),
  ];

  let manifestPath: string | null = null;
  for (const path of manifestPaths) {
    if (existsSync(path)) {
      manifestPath = path;
      break;
    }
  }

  if (!manifestPath) {
    spinner.info('No route manifest found - API routes will not be available');
    return routes;
  }

  try {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest: RouteManifest = JSON.parse(manifestContent);

    if (!manifest.apiRoutes || manifest.apiRoutes.length === 0) {
      spinner.info('No API routes in manifest');
      return routes;
    }

    // Register tsx for TypeScript imports
    await ensureTsxRegistered();

    spinner.start(`Loading ${manifest.apiRoutes.length} API route handlers...`);

    for (const apiRoute of manifest.apiRoutes) {
      try {
        // Find route file
        const routePaths = [
          join(workDir, 'routes', apiRoute.relativePath),
          join(process.cwd(), 'routes', apiRoute.relativePath),
        ];

        let routeFilePath: string | null = null;
        for (const rp of routePaths) {
          if (existsSync(rp)) {
            routeFilePath = rp;
            break;
          }
        }

        if (!routeFilePath) {
          console.warn(`[routes] Route file not found: ${apiRoute.relativePath}`);
          continue;
        }

        // Dynamic import the route module
        const fileUrl = pathToFileURL(routeFilePath).href;
        const routeModule = await import(fileUrl);

        // Register each HTTP method handler
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

        for (const method of methods) {
          if (routeModule[method]) {
            const handlerId = `handler_${method}_${apiRoute.urlPath.replace(/\//g, '_').replace(/:/g, '')}`;

            // Register handler with IPC server
            ipcServer.registerHandler(handlerId, async (req) => {
              try {
                const result = await routeModule[method](req);
                return formatHandlerResponse(result);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[handler] ERROR in ${method} ${apiRoute.urlPath}: ${message}`);
                return {
                  status: 500,
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ error: 'Internal Server Error', message }),
                };
              }
            });

            routes.push({
              method,
              path: apiRoute.urlPath,
              handler_id: handlerId,
              is_typescript: true,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[routes] Failed to load ${apiRoute.relativePath}: ${message}`);
      }
    }

    spinner.succeed(`Loaded ${routes.length} API route handlers`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.warn(`Failed to load route manifest: ${message}`);
  }

  return routes;
}

/**
 * Format handler result into IPC response
 */
function formatHandlerResponse(result: unknown): { status: number; headers: Record<string, string>; body: string } {
  // Handle Response object
  if (result instanceof Response) {
    return {
      status: result.status,
      headers: Object.fromEntries(result.headers.entries()),
      body: '',
    };
  }

  // Handle string
  if (typeof result === 'string') {
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: result,
    };
  }

  // Handle object (JSON)
  if (typeof result === 'object' && result !== null) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    };
  }

  // Default
  return {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: String(result),
  };
}

/**
 * Cleanup temp files
 */
function cleanup(ipcServer: IpcServer | null, configPath: string): void {
  if (ipcServer) {
    try {
      ipcServer.stop();
    } catch {
      // Ignore cleanup errors
    }
  }

  if (configPath && existsSync(configPath)) {
    try {
      unlinkSync(configPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

function printServerInfo(
  host: string,
  port: number,
  workDir: string,
  config?: ProductionConfig | null,
  routeCount?: number
): void {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;

  console.log(chalk.green('\n✓ Production server running\n'));
  console.log(chalk.white('  Endpoints:'));
  console.log(chalk.cyan(`    ➜ http://${displayHost}:${port}`));

  if (host === '0.0.0.0') {
    console.log(chalk.gray(`    ➜ http://0.0.0.0:${port} (all interfaces)`));
  }

  if (routeCount !== undefined && routeCount > 0) {
    console.log(chalk.gray(`\n  API routes: ${routeCount} handlers registered`));
  }

  if (config?.static) {
    console.log(chalk.gray(`  Static files: ${config.static.directory}`));
  }

  console.log(chalk.gray(`\n  Working dir: ${workDir}`));
  console.log(chalk.gray('\n  Press Ctrl+C to stop\n'));
}
