import { join } from "path";
import { tmpdir } from "os";
import { existsSync, readFileSync } from "fs";
import { ProcessManager } from "./process-manager.js";
import { IpcServer } from "./ipc-client.js";
import type {
  Handler,
  ZapRequest,
  ZapHandlerResponse,
  ZapConfig,
  RouteConfig,
  MiddlewareConfig,
  FileRouteConfig,
  ZapOptions,
} from "./types.js";

// Re-export types
export type {
  Handler,
  ZapRequest,
  ZapHandlerResponse,
  ZapConfig,
  RouteConfig,
  MiddlewareConfig,
  StaticFileConfig,
  StaticFileOptions,
  FileRouteConfig,
  ZapOptions,
  IpcMessage,
  InvokeHandlerMessage,
  HandlerResponseMessage,
  ErrorMessage,
  HealthCheckMessage,
  HealthCheckResponseMessage,
  HttpMethod,
  InternalHandlerFunction,
  RpcMessage,
  RpcCallMessage,
  RpcResponseMessage,
  RpcErrorMessage,
  PendingRequest,
  // Security & Observability config types
  SecurityConfig,
  SecurityHeadersConfig,
  HstsConfig,
  RateLimitConfig,
  CorsConfig,
  ObservabilityConfig,
  // Streaming types (Phase 8)
  StreamChunk,
  StreamingHandler,
  AnyHandler,
  StreamStartMessage,
  StreamChunkMessage,
  StreamEndMessage,
  StreamMessage,
  // WebSocket types (Phase 8)
  WsConnection,
  WsHandler,
  WsConnectMessage,
  WsMessageMessage,
  WsCloseMessage,
  WsSendMessage,
  WsMessage,
} from "./types.js";

// Re-export type guards
export {
  isInvokeHandlerMessage,
  isHandlerResponseMessage,
  isErrorMessage,
  isHealthCheckMessage,
  isHealthCheckResponseMessage,
  isRpcResponseMessage,
  isRpcErrorMessage,
  isAsyncIterable,
} from "./types.js";

// Re-export internal modules for dev-server usage
export { ProcessManager } from "./process-manager.js";
export { IpcServer, IpcClient } from "./ipc-client.js";

// Re-export error boundary components and hooks (Phase 10.3)
export {
  ErrorBoundary,
  DefaultErrorComponent,
  RouteErrorContext,
  createRouteError,
  ZapError,
  type ZapRouteError,
  type ErrorComponentProps,
  type ErrorComponent,
} from "./error-boundary.js";

export {
  useRouteError,
  useIsErrorState,
  useErrorState,
} from "./hooks.js";

// Re-export logger (Phase 10.2)
export { Logger, logger, type LogContext, type LogLevel, type ChildLogger } from "./logger.js";

// Re-export client router
export {
  // Provider
  RouterProvider,
  // Hooks
  useRouter,
  useParams,
  usePathname,
  useSearchParams,
  useRouteMatch,
  useIsPending,
  // Components
  Link,
  NavLink,
  Outlet,
  Redirect,
  // Types
  type Router,
  type RouteDefinition,
  type RouteMatch,
  type RouterState,
  type NavigateOptions,
  type LinkProps,
} from "./router.js";

/**
 * Zap - Ultra-fast HTTP server for Node.js and Bun
 *
 * This is the main API entry point. It manages:
 * 1. Route registration from TypeScript
 * 2. Spawning and managing the Rust binary process
 * 3. IPC communication between TypeScript handlers and Rust server
 *
 * Usage:
 * ```
 * const app = new Zap({ port: 3000 });
 * app.get('/', () => ({ message: 'Hello!' }));
 * app.post('/api/data', (req) => ({ received: req.body }));
 * await app.listen();
 * ```
 */
export class Zap {
  private processManager: ProcessManager;
  private ipcServer: IpcServer;
  private handlers: Map<string, Handler> = new Map();
  private routes: RouteConfig[] = [];
  private staticFiles: Array<{ prefix: string; directory: string }> = [];

  private port: number = 3000;
  private hostname: string = "127.0.0.1";
  private logLevel: "trace" | "debug" | "info" | "warn" | "error" = "info";
  private healthCheckPath: string = "/health";
  private metricsPath: string | null = null;

  private enableCors: boolean = false;
  private enableLogging: boolean = false;
  private enableCompression: boolean = false;

  private fileRoutingEnabled: boolean = false;
  private fileRoutingConfig: FileRouteConfig = {};

  constructor(options?: ZapOptions) {
    // Parse options
    if (options?.port) this.port = options.port;
    if (options?.hostname) this.hostname = options.hostname;
    if (options?.logLevel) this.logLevel = options.logLevel;

    // Create IPC socket path (unique per instance)
    const socketPath = join(tmpdir(), `zap-${Date.now()}-${Math.random().toString(36).substring(7)}.sock`);

    // Initialize managers
    this.processManager = new ProcessManager(undefined, socketPath);
    this.ipcServer = new IpcServer(socketPath);
  }

  // ============================================================================
  // Fluent Configuration API
  // ============================================================================

  /**
   * Set the server port
   */
  setPort(port: number): this {
    this.port = port;
    return this;
  }

  /**
   * Set the server hostname
   */
  setHostname(hostname: string): this {
    this.hostname = hostname;
    return this;
  }

  /**
   * Enable CORS middleware
   */
  cors(): this {
    this.enableCors = true;
    return this;
  }

  /**
   * Enable request logging middleware
   */
  logging(): this {
    this.enableLogging = true;
    return this;
  }

  /**
   * Enable response compression middleware
   */
  compression(): this {
    this.enableCompression = true;
    return this;
  }

  /**
   * Set custom health check path
   */
  healthCheck(path: string): this {
    this.healthCheckPath = path;
    return this;
  }

  /**
   * Set metrics endpoint path
   */
  metrics(path: string): this {
    this.metricsPath = path;
    return this;
  }

  /**
   * Enable file-based routing (TanStack style)
   *
   * Automatically registers routes from the routes/ directory
   * using the generated route manifest from @zapjs/router
   */
  useFileRouting(config?: FileRouteConfig): this {
    this.fileRoutingEnabled = true;
    this.fileRoutingConfig = config || {};
    return this;
  }

  // ============================================================================
  // Route Registration API
  // ============================================================================

  /**
   * Register a GET route
   */
  get<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("GET", path, handler as Handler);
  }

  /**
   * Register a POST route
   */
  post<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("POST", path, handler as Handler);
  }

  /**
   * Register a PUT route
   */
  put<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("PUT", path, handler as Handler);
  }

  /**
   * Register a DELETE route
   */
  delete<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("DELETE", path, handler as Handler);
  }

  /**
   * Register a PATCH route
   */
  patch<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("PATCH", path, handler as Handler);
  }

  /**
   * Register a HEAD route
   */
  head<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.registerRoute("HEAD", path, handler as Handler);
  }

  /**
   * Convenience method for GET routes that return JSON
   */
  getJson<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.get(path, handler);
  }

  /**
   * Convenience method for POST routes that return JSON
   */
  postJson<TParams extends Record<string, string> = Record<string, string>>(
    path: string,
    handler: Handler<TParams>
  ): this {
    return this.post(path, handler);
  }

  /**
   * Register static file serving
   */
  static(prefix: string, directory: string): this {
    this.staticFiles.push({ prefix, directory });
    return this;
  }

  /**
   * Register a route with a handler (internal)
   */
  private registerRoute(
    method: string,
    path: string,
    handler: Handler
  ): this {
    const handlerId = `handler_${this.handlers.size}`;
    this.handlers.set(handlerId, handler);

    this.routes.push({
      method,
      path,
      handler_id: handlerId,
      is_typescript: true,
    });

    return this;
  }

  // ============================================================================
  // Server Lifecycle
  // ============================================================================

  /**
   * Start the server
   */
  async listen(port?: number): Promise<void> {
    // Allow overriding port in listen()
    if (port !== undefined) {
      this.port = port;
    }

    try {
      // Load file-based routes if enabled
      if (this.fileRoutingEnabled) {
        await this.loadFileRoutes();
      }

      // Start IPC server first
      console.log("[Zap] Starting IPC server...");
      await this.ipcServer.start();

      // Register all handlers with IPC server
      console.log(`[Zap] Registering ${this.handlers.size} handlers...`);
      for (const [handlerId, handler] of this.handlers) {
        this.ipcServer.registerHandler(handlerId, async (req: ZapRequest): Promise<ZapHandlerResponse> => {
          const result = await handler(req);

          // Handle different response types
          if (result instanceof Response) {
            // Convert Headers to Record<string, string>
            const headersObj: Record<string, string> = {};
            result.headers.forEach((value, key) => {
              headersObj[key] = value;
            });
            return {
              status: result.status,
              headers: headersObj,
              body: await result.text(),
            };
          }

          if (typeof result === "string") {
            return {
              status: 200,
              headers: { "content-type": "text/plain" },
              body: result,
            };
          }

          // Default to JSON
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(result),
          };
        });
      }

      // Build Rust configuration
      const config: ZapConfig = {
        port: this.port,
        hostname: this.hostname,
        ipc_socket_path: this.processManager.getSocketPath(),
        routes: this.routes,
        static_files: this.staticFiles,
        middleware: {
          enable_cors: this.enableCors,
          enable_logging: this.enableLogging,
          enable_compression: this.enableCompression,
        },
        health_check_path: this.healthCheckPath,
        metrics_path: this.metricsPath ?? undefined,
      };

      // Start Rust server process
      console.log("[Zap] Starting Rust server process...");
      await this.processManager.start(config, this.logLevel);

      console.log(`[Zap] Server listening on http://${this.hostname}:${this.port}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Zap] Failed to start server:", message);
      await this.close();
      throw error;
    }
  }

  /**
   * Close the server gracefully
   */
  async close(): Promise<void> {
    console.log("[Zap] Closing server...");

    try {
      await this.processManager.stop();
      await this.ipcServer.stop();
      console.log("[Zap] Server closed");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Zap] Error closing server:", message);
      throw error;
    }
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.processManager.isRunning();
  }

  /**
   * Load routes from generated route manifest
   */
  private async loadFileRoutes(): Promise<void> {
    const generatedDir = this.fileRoutingConfig.generatedDir || join(process.cwd(), 'src', 'generated');
    const manifestPath = join(generatedDir, 'routeManifest.json');

    if (!existsSync(manifestPath)) {
      console.log("[Zap] No route manifest found. Run route scanner first.");
      return;
    }

    try {
      const manifestContent = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as {
        apiRoutes?: Array<{ filePath: string; urlPath: string }>;
      };
      console.log(`[Zap] Loading ${manifest.apiRoutes?.length ?? 0} API routes from manifest...`);

      // Register API routes
      for (const route of manifest.apiRoutes ?? []) {
        // Convert :param to Rust radix router format
        const rustPath = route.urlPath;

        // Import the route handler module
        const routeFile = join(process.cwd(), 'routes', route.filePath);

        if (existsSync(routeFile.replace(/\.ts$/, '.js')) || existsSync(routeFile)) {
          try {
            const routeModule = await import(routeFile) as Record<string, Handler | undefined>;

            // Register each HTTP method handler
            const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
            for (const method of methods) {
              const methodHandler = routeModule[method];
              if (methodHandler) {
                this.registerRoute(method, rustPath, methodHandler);
                console.log(`[Zap]   ${method} ${rustPath}`);
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(`[Zap] Failed to import ${routeFile}: ${message}`);
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Zap] Failed to load route manifest:", message);
    }
  }
}

export default Zap;
