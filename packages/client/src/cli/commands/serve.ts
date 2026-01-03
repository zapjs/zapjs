import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { findAvailablePort } from '../utils/port-finder.js';
import { IpcServer, ProcessManager, ZapConfig, RouteConfig } from '../../runtime/index.js';
import { cliLogger } from '../utils/logger.js';
import { SpliceManager } from '../../dev-server/splice-manager.js';

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
  try {
    cliLogger.header('ZapJS Production Server');

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
      cliLogger.error('No production binary found');
      cliLogger.info('Run `zap build` first to create a production build');
      process.exit(1);
    }

    // Load production config if available
    let prodConfig: ProductionConfig | null = null;
    const configPath = options.config || join(workDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        prodConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        cliLogger.success(`Loaded config from ${configPath}`);
      } catch {
        cliLogger.warn('Failed to parse config.json, using defaults');
      }
    }

    await runProductionServer(binPath, options, workDir, prodConfig);

  } catch (error) {
    cliLogger.error('Failed to start server');
    if (error instanceof Error) {
      cliLogger.error('Error details', error.message);
    }
    process.exit(1);
  }
}

/**
 * Wait for Rust server to create RPC socket file
 */
async function waitForRpcSocket(socketPath: string): Promise<void> {
  const rpcSocketPath = socketPath + '.rpc';
  const maxWait = 10000; // 10 seconds
  const checkInterval = 100; // 100ms
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (existsSync(rpcSocketPath)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  throw new Error(`RPC socket not ready within ${maxWait}ms`);
}

async function runProductionServer(
  binPath: string,
  options: ServeOptions,
  workDir: string,
  prodConfig?: ProductionConfig | null
): Promise<void> {
  const port = parseInt(options.port || prodConfig?.server?.port?.toString() || '3000');
  const host = options.host || prodConfig?.server?.host || '0.0.0.0';
  const logLevel = options.logLevel || prodConfig?.logging?.level || 'info';

  // Find available port
  cliLogger.spinner('port', `Checking port ${port}...`);
  const availablePort = await findAvailablePort(port);

  if (availablePort !== port) {
    cliLogger.warn(`Port ${port} in use, using ${availablePort}`);
  } else {
    cliLogger.succeedSpinner('port', `Port ${availablePort} available`);
  }

  // Generate unique socket path
  const socketPath = join(tmpdir(), `zap-prod-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

  // Check for Splice and user server binaries
  let spliceManager: SpliceManager | null = null;
  const spliceBinPath = join(workDir, 'bin', 'splice');
  const userServerBinPath = join(workDir, 'bin', 'server');

  if (existsSync(spliceBinPath) && existsSync(userServerBinPath)) {
    cliLogger.spinner('splice-prod', 'Starting Splice...');

    const spliceSocketPath = join(tmpdir(), `splice-prod-${Date.now()}.sock`);

    spliceManager = new SpliceManager({
      spliceBinaryPath: spliceBinPath,
      workerBinaryPath: userServerBinPath,
      socketPath: spliceSocketPath,
      maxConcurrency: 1024,
      timeout: 30,
    });

    try {
      await spliceManager.start();
      cliLogger.succeedSpinner('splice-prod', 'Splice started');
    } catch (err) {
      cliLogger.failSpinner('splice-prod', 'Splice failed to start');
      const message = err instanceof Error ? err.message : String(err);
      cliLogger.warn(`Continuing without Splice: ${message}`);
      spliceManager = null;
    }
  }

  // Start IPC server for TypeScript handlers
  cliLogger.spinner('ipc', 'Starting IPC server...');
  const ipcServer = new IpcServer(socketPath);
  await ipcServer.start();
  cliLogger.succeedSpinner('ipc', 'IPC server started');

  // Load and register route handlers
  const routes = await loadRouteHandlers(ipcServer, workDir);

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

  // Add Splice socket if available
  if (spliceManager && spliceManager.isRunning()) {
    zapConfig.splice_socket_path = spliceManager.getSocketPath();
  }

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
  cliLogger.spinner('rust', 'Starting Rust HTTP server...');

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

  // Wait for Rust server to create RPC socket, then initialize RPC client
  cliLogger.spinner('rpc', 'Waiting for RPC server...');
  try {
    await waitForRpcSocket(socketPath);

    // Initialize RPC client for bidirectional IPC communication
    // This allows TypeScript route handlers to call Rust functions via rpc.call()
    const { initRpcClient } = await import('../../runtime/rpc-client.js');
    await initRpcClient(socketPath + '.rpc');
    cliLogger.succeedSpinner('rpc', 'RPC client connected');
  } catch (err) {
    cliLogger.failSpinner('rpc', 'Failed to connect RPC client');
    const message = err instanceof Error ? err.message : String(err);
    cliLogger.error(message);
    cleanup(ipcServer, tempConfigPath, spliceManager);
    if (!rustProcess.killed) {
      rustProcess.kill();
    }
    process.exit(1);
  }

  let started = false;

  rustProcess.stdout?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started && (output.includes('listening') || output.includes('Server'))) {
      started = true;
      cliLogger.succeedSpinner('rust', 'Server started');
      printServerInfo(host, availablePort, workDir, prodConfig, routes.length);
    }
    if (started) {
      process.stdout.write(output);
    }
  });

  rustProcess.stderr?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started) {
      // Don't fail immediately on stderr - Rust logs info to stderr sometimes
      if (output.includes('error') || output.includes('Error')) {
        cliLogger.failSpinner('rust', 'Server failed to start');
        cliLogger.error(output);
        cleanup(ipcServer, tempConfigPath, spliceManager);
        process.exit(1);
      }
    }
    process.stderr.write(output);
  });

  rustProcess.on('error', (err: Error) => {
    cliLogger.failSpinner('rust', `Failed to start: ${err.message}`);
    cleanup(ipcServer, tempConfigPath, spliceManager);
    process.exit(1);
  });

  rustProcess.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      cliLogger.error(`Server exited with code ${code}`);
      cleanup(ipcServer, tempConfigPath, spliceManager);
      process.exit(code);
    }
  });

  // If server doesn't output "listening", assume it started after a delay
  setTimeout(() => {
    if (!started) {
      started = true;
      cliLogger.succeedSpinner('rust', 'Server started');
      printServerInfo(host, availablePort, workDir, prodConfig, routes.length);
    }
  }, 3000);

  // Graceful shutdown
  const shutdown = async () => {
    cliLogger.warn('Shutting down...');

    // Kill Rust process
    if (!rustProcess.killed) {
      rustProcess.kill('SIGTERM');
    }

    // Stop IPC server
    await ipcServer.stop();

    // Cleanup temp config
    cleanup(null, tempConfigPath, spliceManager);

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
  workDir: string
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
    cliLogger.info('No route manifest found - API routes will not be available');
    return routes;
  }

  try {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest: RouteManifest = JSON.parse(manifestContent);

    if (!manifest.apiRoutes || manifest.apiRoutes.length === 0) {
      cliLogger.info('No API routes in manifest');
      return routes;
    }

    // Register tsx for TypeScript imports
    await ensureTsxRegistered();

    cliLogger.spinner('routes', `Loading ${manifest.apiRoutes.length} API route handlers...`);

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
          cliLogger.warn(`[routes] Route file not found: ${apiRoute.relativePath}`);
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
            ipcServer.registerHandler(handlerId, async (req: unknown) => {
              try {
                const result = await routeModule[method](req);
                return formatHandlerResponse(result);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                cliLogger.error(`[handler] ERROR in ${method} ${apiRoute.urlPath}:`, message);
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
        cliLogger.warn(`[routes] Failed to load ${apiRoute.relativePath}: ${message}`);
      }
    }

    cliLogger.succeedSpinner('routes', `Loaded ${routes.length} API route handlers`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cliLogger.warn(`Failed to load route manifest: ${message}`);
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
function cleanup(ipcServer: IpcServer | null, configPath: string, spliceManager?: SpliceManager | null): void {
  if (spliceManager) {
    try {
      spliceManager.stop();
    } catch {
      // Ignore cleanup errors
    }
  }

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

  cliLogger.newline();
  cliLogger.success('Production server running');
  cliLogger.newline();
  cliLogger.info('Endpoints:');
  cliLogger.listItem(`http://${displayHost}:${port}`, '➜');

  if (host === '0.0.0.0') {
    cliLogger.listItem(`http://0.0.0.0:${port} (all interfaces)`, '➜');
  }

  if (routeCount !== undefined && routeCount > 0) {
    cliLogger.newline();
    cliLogger.keyValue('API routes', `${routeCount} handlers registered`);
  }

  if (config?.static) {
    cliLogger.keyValue('Static files', config.static.directory);
  }

  cliLogger.newline();
  cliLogger.keyValue('Working dir', workDir);
  cliLogger.newline();
  cliLogger.info('Press Ctrl+C to stop');
  cliLogger.newline();
}
