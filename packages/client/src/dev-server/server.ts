import { EventEmitter } from 'events';
import path from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { FileWatcher, WatchEvent } from './watcher.js';
import { RustBuilder, BuildResult } from './rust-builder.js';
import { ViteProxy } from './vite-proxy.js';
import { CodegenRunner } from './codegen-runner.js';
import { HotReloadServer } from './hot-reload.js';
import { RouteScannerRunner } from './route-scanner.js';
import { ProcessManager, IpcServer, ZapConfig, RouteConfig } from '../runtime/index.js';
import { initRpcClient } from '../runtime/rpc-client.js';
import { cliLogger } from '../cli/utils/logger.js';

// Register tsx loader for TypeScript imports
// This must be called before any dynamic imports of .ts files
let tsxRegistered = false;
async function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return;
  try {
    const tsx = await import('tsx/esm/api');
    tsx.register();
    tsxRegistered = true;
  } catch {
    // tsx not available, TypeScript imports won't work
  }
}

export interface DevServerConfig {
  projectDir: string;
  rustPort?: number;
  vitePort?: number;
  hotReloadPort?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  release?: boolean;
  skipInitialBuild?: boolean;
  openBrowser?: boolean;
  /** Path to pre-built zap binary (skips Rust compilation) */
  binaryPath?: string;
  /** Path to pre-built zap-codegen binary */
  codegenBinaryPath?: string;
}

interface ServerState {
  phase: 'starting' | 'building' | 'ready' | 'rebuilding' | 'error' | 'stopped';
  rustReady: boolean;
  viteReady: boolean;
  lastError: string | null;
}

// Route tree type from route scanner
interface ApiRoute {
  filePath: string;
  relativePath: string;
  urlPath: string;
  type: string;
  params: Array<{ name: string; index: number; catchAll: boolean }>;
  methods?: string[];
  isIndex: boolean;
}

interface RouteTree {
  routes: Array<{ filePath: string; urlPath: string }>;
  apiRoutes: ApiRoute[];
  layouts: unknown[];
  root: unknown;
}

/**
 * DevServer - Unified development server orchestrator
 *
 * Coordinates all development components:
 * - Rust backend compilation with file watching
 * - Vite frontend dev server
 * - Automatic TypeScript binding generation
 * - Hot reload signaling
 *
 * Workflow:
 * 1. Initial build of Rust backend
 * 2. Generate TypeScript bindings
 * 3. Start Vite dev server
 * 4. Start hot reload WebSocket server
 * 5. Watch for file changes and orchestrate rebuilds
 */
export class DevServer extends EventEmitter {
  private config: DevServerConfig;
  private state: ServerState;

  // Components
  private watcher: FileWatcher;
  private rustBuilder: RustBuilder;
  private viteProxy: ViteProxy;
  private codegenRunner: CodegenRunner;
  private hotReloadServer: HotReloadServer;
  private routeScanner: RouteScannerRunner;

  // Runtime components for Rust server + IPC
  private processManager: ProcessManager | null = null;
  private ipcServer: IpcServer | null = null;
  private socketPath: string = '';
  private currentRouteTree: RouteTree | null = null;
  private registeredHandlers: Map<string, string> = new Map(); // handlerId -> filePath

  // Timing
  private startTime: number = 0;

  constructor(config: DevServerConfig) {
    super();
    this.config = {
      rustPort: 3000,
      vitePort: 5173,
      hotReloadPort: 3001,
      logLevel: 'info',
      release: false,
      skipInitialBuild: false,
      openBrowser: false,
      ...config,
    };

    // If binaryPath is provided, skip initial build
    if (this.config.binaryPath) {
      this.config.skipInitialBuild = true;
    }

    this.state = {
      phase: 'starting',
      rustReady: false,
      viteReady: false,
      lastError: null,
    };

    // Initialize components
    this.watcher = new FileWatcher({
      rootDir: this.config.projectDir,
    });

    this.rustBuilder = new RustBuilder({
      projectDir: this.config.projectDir,
      release: this.config.release,
      bin: 'zap',
      binaryPath: this.config.binaryPath,
    });

    this.viteProxy = new ViteProxy({
      projectDir: this.config.projectDir,
      port: this.config.vitePort,
    });

    this.codegenRunner = new CodegenRunner({
      projectDir: this.config.projectDir,
      codegenBinary: this.config.codegenBinaryPath,
    });

    this.hotReloadServer = new HotReloadServer({
      port: this.config.hotReloadPort,
    });

    this.routeScanner = new RouteScannerRunner({
      projectDir: this.config.projectDir,
    });

    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for all components
   */
  private setupEventHandlers(): void {
    // File watcher events
    this.watcher.on('rust', (event: WatchEvent) => this.handleRustChange(event));
    this.watcher.on('typescript', (event: WatchEvent) => this.handleTypeScriptChange(event));
    this.watcher.on('config', (event: WatchEvent) => this.handleConfigChange(event));
    this.watcher.on('error', (err) => this.log('error', `Watcher error: ${err.message}`));

    // Rust builder events
    this.rustBuilder.on('build-start', () => {
      this.state.phase = 'rebuilding';
      this.emit('rust-build-start');
    });

    this.rustBuilder.on('build-complete', (result: BuildResult) => {
      this.emit('rust-build-complete', result);
    });

    this.rustBuilder.on('error', (msg: string) => {
      this.log('error', msg);
    });

    this.rustBuilder.on('warning', (msg: string) => {
      this.log('warn', msg);
    });

    // Vite events
    this.viteProxy.on('ready', (port: number) => {
      this.state.viteReady = true;
      this.emit('vite-ready', port);
    });

    this.viteProxy.on('error', (err: Error) => {
      this.log('error', `Vite error: ${err.message}`);
    });

    this.viteProxy.on('hmr-update', () => {
      this.emit('hmr-update');
    });

    // Hot reload events
    this.hotReloadServer.on('client-connected', () => {
      this.log('debug', 'Hot reload client connected');
    });

    // Codegen events
    this.codegenRunner.on('complete', (result: { success: boolean }) => {
      if (result.success) {
        this.log('info', 'TypeScript bindings regenerated');
      }
    });

    // Route scanner events
    this.routeScanner.on('routes-changed', async (tree) => {
      this.log('info', `Routes updated (${tree.routes.length} pages, ${tree.apiRoutes.length} API)`);
      this.hotReloadServer.reload('routes', []);

      // Restart Rust server to pick up new routes
      try {
        await this.restartRustServer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('error', `Failed to restart Rust server: ${message}`);
      }
    });

    this.routeScanner.on('error', (err) => {
      this.log('warn', `Route scanner error: ${err.message}`);
    });
  }

  /**
   * Start the development server
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    cliLogger.header('ZapJS Dev Server');

    try {
      // Phase 1: Initial Rust build
      if (!this.config.skipInitialBuild) {
        await this.buildRust();
      }

      // Phase 2: Generate TypeScript bindings
      await this.runCodegen();

      // Phase 2.5: Scan routes
      const routeTree = await this.scanRoutes();
      this.currentRouteTree = routeTree;

      // Phase 3: Start Rust HTTP server with IPC
      await this.startRustServer(routeTree);

      // Phase 4: Start other servers in parallel
      await Promise.all([
        this.startHotReloadServer(),
        this.startViteServer(),
      ]);

      // Phase 5: Start file watcher and route watcher
      this.startWatcher();
      await this.startRouteWatcher();

      // Ready!
      this.state.phase = 'ready';
      this.printReadyMessage();

      // Open browser if requested
      if (this.config.openBrowser) {
        this.openBrowser();
      }

    } catch (err) {
      this.state.phase = 'error';
      this.state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Stop all servers immediately
   */
  async stop(): Promise<void> {
    if (this.state.phase === 'stopped') return;
    this.state.phase = 'stopped';
    cliLogger.newline();
    cliLogger.warn('Shutting down...');

    // Kill Rust server first (most important)
    if (this.processManager) {
      this.processManager.stop();
      this.processManager = null;
    }

    // Stop IPC
    if (this.ipcServer) {
      this.ipcServer.stop();
      this.ipcServer = null;
    }

    // Stop other components
    try {
      this.watcher.stop();
      this.viteProxy.stop();
      this.hotReloadServer.stop();
      this.routeScanner.stopWatching();
      this.rustBuilder.cancel();
    } catch {
      // Ignore errors during cleanup
    }

    cliLogger.success('Goodbye!');
    cliLogger.newline();
    process.exit(0);
  }

  /**
   * Build Rust backend
   */
  private async buildRust(): Promise<void> {
    cliLogger.spinner('rust-build', 'Building Rust backend...');

    const result = await this.rustBuilder.build();

    if (result.success) {
      const duration = (result.duration / 1000).toFixed(2);
      cliLogger.succeedSpinner('rust-build', `Rust build complete (${duration}s)`);
      this.state.rustReady = true;

      if (result.warnings.length > 0) {
        cliLogger.warn(`${result.warnings.length} warnings`);
      }
    } else {
      cliLogger.failSpinner('rust-build', 'Rust build failed');

      for (const error of result.errors) {
        cliLogger.error(error);
      }

      throw new Error('Rust build failed');
    }
  }

  /**
   * Run codegen to generate TypeScript bindings
   */
  private async runCodegen(): Promise<void> {
    cliLogger.spinner('codegen', 'Generating TypeScript bindings...');

    const success = await this.codegenRunner.run();

    if (success) {
      cliLogger.succeedSpinner('codegen', 'TypeScript bindings generated');
    } else {
      cliLogger.warn('Codegen skipped (binary not found)');
    }
  }

  /**
   * Scan routes directory and generate route tree
   */
  private async scanRoutes(): Promise<RouteTree | null> {
    if (!this.routeScanner.hasRoutesDir()) {
      this.log('debug', 'No routes directory found');
      return null;
    }

    cliLogger.spinner('routes', 'Scanning routes...');

    const tree = await this.routeScanner.scan() as RouteTree | null;

    if (tree) {
      cliLogger.succeedSpinner('routes', `Found ${tree.routes.length} pages, ${tree.apiRoutes.length} API routes`);
      return tree;
    } else {
      cliLogger.warn('Route scanning skipped');
      return null;
    }
  }

  /**
   * Start the Rust HTTP server with IPC for TypeScript handlers
   */
  private async startRustServer(routeTree: RouteTree | null): Promise<void> {
    cliLogger.spinner('rust-server', 'Starting Rust HTTP server...');

    try {
      // Generate unique socket path for this dev session
      this.socketPath = path.join(tmpdir(), `zap-dev-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

      // Create and start IPC server first
      this.ipcServer = new IpcServer(this.socketPath);
      await this.ipcServer.start();
      this.log('debug', `IPC server listening on ${this.socketPath}`);

      // Initialize RPC client for bidirectional IPC communication
      // This allows TypeScript route handlers to call Rust functions via rpc.call()
      initRpcClient(this.socketPath);
      this.log('debug', `RPC client initialized on ${this.socketPath}`);

      // Load and register route handlers
      const routes = await this.loadRouteHandlers(routeTree);
      console.log(`[dev-server] Loaded ${routes.length} route configurations`);

      // Build Rust server configuration
      const config = this.buildRustConfig(routes);
      console.log(`[dev-server] Built Rust config with ${config.routes.length} routes`);

      // Get binary path
      const binaryPath = this.rustBuilder.getBinaryPath();
      this.log('debug', `Using Rust binary: ${binaryPath}`);

      // Create process manager and start Rust server
      this.processManager = new ProcessManager(binaryPath, this.socketPath);
      await this.processManager.start(config, this.config.logLevel || 'info');

      this.state.rustReady = true;
      cliLogger.succeedSpinner('rust-server', `Rust server ready on port ${this.config.rustPort}`);
    } catch (err) {
      cliLogger.failSpinner('rust-server', 'Failed to start Rust server');
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `Rust server error: ${message}`);
      throw err;
    }
  }

  /**
   * Load TypeScript route handlers and register them with IPC server
   */
  private async loadRouteHandlers(routeTree: RouteTree | null): Promise<RouteConfig[]> {
    const routes: RouteConfig[] = [];

    if (!routeTree || !routeTree.apiRoutes || routeTree.apiRoutes.length === 0) {
      console.log('[routes] No API routes to register');
      return routes;
    }

    // Register tsx loader for TypeScript imports
    await ensureTsxRegistered();

    console.log(`[routes] Loading ${routeTree.apiRoutes.length} API route handlers...`);

    for (const apiRoute of routeTree.apiRoutes) {
      try {
        // Construct the full file path
        const routeFilePath = path.join(this.config.projectDir, 'routes', apiRoute.relativePath);
        console.log(`[routes] Loading: ${routeFilePath}`);

        // Dynamic import the route module using file URL for ESM compatibility
        const fileUrl = pathToFileURL(routeFilePath).href;
        const routeModule = await import(fileUrl);
        console.log(`[routes] Loaded module, exports: ${Object.keys(routeModule).join(', ')}`);

        // Check for each HTTP method handler
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

        for (const method of methods) {
          if (routeModule[method]) {
            const handlerId = `handler_${method}_${apiRoute.urlPath.replace(/\//g, '_').replace(/:/g, '')}`;
            console.log(`[routes] Registering handler: ${handlerId} for ${method} ${apiRoute.urlPath}`);

            // Register handler with IPC server
            this.ipcServer!.registerHandler(handlerId, async (req) => {
              console.log(`[handler] Received request: ${method} ${apiRoute.urlPath}`);
              console.log(`[handler] Request data:`, JSON.stringify(req, null, 2));
              try {
                // Call the route handler
                console.log(`[handler] Calling handler function...`);
                const result = await routeModule[method](req);
                console.log(`[handler] Handler returned:`, JSON.stringify(result, null, 2));

                // Convert result to IPC response format
                const response = this.formatHandlerResponse(result);
                console.log(`[handler] Formatted response:`, JSON.stringify(response, null, 2));
                return response;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                console.error(`[handler] ERROR in ${method} ${apiRoute.urlPath}: ${message}`);
                console.error(`[handler] Stack: ${stack}`);
                return {
                  status: 500,
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ error: 'Internal Server Error', message }),
                };
              }
            });

            // Track handler mapping
            this.registeredHandlers.set(handlerId, routeFilePath);

            // Add route to config
            routes.push({
              method,
              path: apiRoute.urlPath,
              handler_id: handlerId,
              is_typescript: true,
            });

            console.log(`[routes] ✓ Registered: ${method} ${apiRoute.urlPath} -> ${handlerId}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[routes] Failed to load ${apiRoute.relativePath}: ${message}`);
      }
    }

    console.log(`[routes] Total registered: ${routes.length} API handlers`);
    return routes;
  }

  /**
   * Format handler result into IPC response
   */
  private formatHandlerResponse(result: unknown): { status: number; headers: Record<string, string>; body: string } {
    // Handle Response object
    if (result instanceof Response) {
      return {
        status: result.status,
        headers: Object.fromEntries(result.headers.entries()),
        body: '', // Will need to await text() but keeping sync for now
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
   * Build Rust server configuration from routes
   */
  private buildRustConfig(routes: RouteConfig[]): ZapConfig {
    return {
      port: this.config.rustPort!,
      hostname: '127.0.0.1',
      ipc_socket_path: this.socketPath,
      routes,
      static_files: [],
      middleware: {
        enable_cors: true,
        enable_logging: true,
        enable_compression: false,
      },
      health_check_path: '/health',
      metrics_path: '/metrics',
    };
  }

  /**
   * Restart Rust server (called when routes change)
   */
  private async restartRustServer(): Promise<void> {
    this.log('info', 'Restarting Rust server...');

    // Stop existing server
    if (this.processManager) {
      await this.processManager.stop();
    }
    if (this.ipcServer) {
      await this.ipcServer.stop();
    }

    // Clear registered handlers
    this.registeredHandlers.clear();

    // Re-scan routes and restart
    const routeTree = await this.scanRoutes();
    this.currentRouteTree = routeTree;
    await this.startRustServer(routeTree);
  }

  /**
   * Start the route file watcher
   */
  private async startRouteWatcher(): Promise<void> {
    if (!this.routeScanner.hasRoutesDir()) {
      return;
    }

    await this.routeScanner.startWatching();
    this.log('debug', 'Route watcher started');
  }

  /**
   * Start the hot reload WebSocket server
   */
  private async startHotReloadServer(): Promise<void> {
    await this.hotReloadServer.start();
    this.log('debug', `Hot reload server on port ${this.config.hotReloadPort}`);
  }

  /**
   * Start the Vite dev server
   */
  private async startViteServer(): Promise<void> {
    cliLogger.spinner('vite', 'Starting Vite dev server...');

    try {
      await this.viteProxy.start();
      cliLogger.succeedSpinner('vite', `Vite ready on port ${this.viteProxy.getPort()}`);
    } catch (err) {
      cliLogger.warn('Vite not available (frontend only)');
      this.log('debug', `Vite error: ${err}`);
    }
  }

  /**
   * Start the file watcher
   */
  private startWatcher(): void {
    this.watcher.start();
    this.log('debug', 'File watcher started');
  }

  /**
   * Handle Rust file changes
   */
  private async handleRustChange(event: WatchEvent): Promise<void> {
    const relativePath = path.relative(this.config.projectDir, event.path);
    cliLogger.newline();
    cliLogger.info(`[${event.type}] ${relativePath}`);

    cliLogger.spinner('rust-rebuild', 'Rebuilding Rust...');

    const result = await this.rustBuilder.build();

    if (result.success) {
      const duration = (result.duration / 1000).toFixed(2);
      cliLogger.succeedSpinner('rust-rebuild', `Rust rebuild complete (${duration}s)`);

      // Regenerate bindings
      await this.codegenRunner.run();

      // Signal hot reload
      this.hotReloadServer.reload('rust', [relativePath]);
      this.state.phase = 'ready';
    } else {
      cliLogger.failSpinner('rust-rebuild', 'Rust build failed');

      for (const error of result.errors.slice(0, 3)) {
        cliLogger.error(error);
      }

      // Notify clients of error
      this.hotReloadServer.notifyError(result.errors.join('\n'));
      this.state.phase = 'error';
    }
  }

  /**
   * Handle TypeScript file changes
   */
  private async handleTypeScriptChange(event: WatchEvent): Promise<void> {
    const relativePath = path.relative(this.config.projectDir, event.path);
    this.log('debug', `[${event.type}] ${relativePath}`);

    // Vite HMR handles TypeScript changes automatically
    // Just emit the event for logging
    this.emit('typescript-change', event);
  }

  /**
   * Handle config file changes
   */
  private async handleConfigChange(event: WatchEvent): Promise<void> {
    const relativePath = path.relative(this.config.projectDir, event.path);
    cliLogger.newline();
    cliLogger.warn(`[config] ${relativePath}`);

    // For significant config changes, restart might be needed
    if (relativePath.includes('Cargo.toml')) {
      cliLogger.warn('Cargo.toml changed - rebuilding...');
      await this.handleRustChange(event);
    } else if (relativePath.includes('vite.config')) {
      cliLogger.warn('Vite config changed - restarting Vite...');
      await this.viteProxy.restart();
    }
  }

  /**
   * Print the ready message
   */
  private printReadyMessage(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);

    cliLogger.newline();
    cliLogger.success(`Dev server ready in ${elapsed}s`);
    cliLogger.newline();
    cliLogger.info('Servers:');
    cliLogger.listItem(`API:        http://127.0.0.1:${this.config.rustPort}`, '➜');

    if (this.viteProxy.getPort()) {
      cliLogger.listItem(`Frontend:   http://127.0.0.1:${this.viteProxy.getPort()}`, '➜');
    }

    cliLogger.listItem(`Hot Reload: ws://127.0.0.1:${this.config.hotReloadPort}`, '➜');
    cliLogger.newline();
    cliLogger.info('Press Ctrl+C to stop');
    cliLogger.newline();

    // Show keyboard shortcuts
    cliLogger.info('Shortcuts:');
    console.log('    r - Rebuild Rust');
    console.log('    c - Regenerate codegen');
    console.log('    q - Quit');
    cliLogger.newline();

    // Setup keyboard input
    this.setupKeyboardInput();
  }

  /**
   * Set up keyboard input handling
   */
  private setupKeyboardInput(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      process.stdin.on('data', async (key: string) => {
        // Ctrl+C
        if (key === '\u0003') {
          await this.stop();
          process.exit(0);
        }

        // 'r' - rebuild
        if (key === 'r') {
          cliLogger.newline();
          cliLogger.info('Manual rebuild triggered...');
          await this.rustBuilder.build();
        }

        // 'c' - codegen
        if (key === 'c') {
          cliLogger.newline();
          cliLogger.info('Regenerating bindings...');
          await this.codegenRunner.run();
        }

        // 'q' - quit
        if (key === 'q') {
          await this.stop();
          process.exit(0);
        }
      });
    }
  }

  /**
   * Open the browser
   */
  private openBrowser(): void {
    const url = this.viteProxy.getPort()
      ? `http://127.0.0.1:${this.viteProxy.getPort()}`
      : `http://127.0.0.1:${this.config.rustPort}`;

    import('child_process').then(({ exec }) => {
      const command = process.platform === 'darwin' ? 'open' :
                     process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${command} ${url}`);
    });
  }

  /**
   * Log a message with the appropriate level
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configLevel = levels[this.config.logLevel || 'info'];
    const msgLevel = levels[level];

    if (msgLevel >= configLevel) {
      const prefix = {
        debug: '[debug]',
        info: '[info]',
        warn: '[warn]',
        error: '[error]',
      }[level];

      console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Get current server state
   */
  getState(): ServerState {
    return { ...this.state };
  }
}
