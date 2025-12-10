import { join } from "path";
import { tmpdir } from "os";
import { ProcessManager } from "./process-manager";
import { IpcServer } from "./ipc-client";
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
    constructor(options) {
        this.handlers = new Map();
        this.routes = [];
        this.staticFiles = [];
        this.port = 3000;
        this.hostname = "127.0.0.1";
        this.logLevel = "info";
        this.healthCheckPath = "/health";
        this.metricsPath = null;
        this.enableCors = false;
        this.enableLogging = false;
        this.enableCompression = false;
        // Parse options
        if (options?.port)
            this.port = options.port;
        if (options?.hostname)
            this.hostname = options.hostname;
        if (options?.logLevel)
            this.logLevel = options.logLevel;
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
    setPort(port) {
        this.port = port;
        return this;
    }
    /**
     * Set the server hostname
     */
    setHostname(hostname) {
        this.hostname = hostname;
        return this;
    }
    /**
     * Enable CORS middleware
     */
    cors() {
        this.enableCors = true;
        return this;
    }
    /**
     * Enable request logging middleware
     */
    logging() {
        this.enableLogging = true;
        return this;
    }
    /**
     * Enable response compression middleware
     */
    compression() {
        this.enableCompression = true;
        return this;
    }
    /**
     * Set custom health check path
     */
    healthCheck(path) {
        this.healthCheckPath = path;
        return this;
    }
    /**
     * Set metrics endpoint path
     */
    metrics(path) {
        this.metricsPath = path;
        return this;
    }
    // ============================================================================
    // Route Registration API
    // ============================================================================
    /**
     * Register a GET route
     */
    get(path, handler) {
        return this.registerRoute("GET", path, handler);
    }
    /**
     * Register a POST route
     */
    post(path, handler) {
        return this.registerRoute("POST", path, handler);
    }
    /**
     * Register a PUT route
     */
    put(path, handler) {
        return this.registerRoute("PUT", path, handler);
    }
    /**
     * Register a DELETE route
     */
    delete(path, handler) {
        return this.registerRoute("DELETE", path, handler);
    }
    /**
     * Register a PATCH route
     */
    patch(path, handler) {
        return this.registerRoute("PATCH", path, handler);
    }
    /**
     * Register a HEAD route
     */
    head(path, handler) {
        return this.registerRoute("HEAD", path, handler);
    }
    /**
     * Convenience method for GET routes that return JSON
     */
    getJson(path, handler) {
        return this.get(path, handler);
    }
    /**
     * Convenience method for POST routes that return JSON
     */
    postJson(path, handler) {
        return this.post(path, handler);
    }
    /**
     * Register static file serving
     */
    static(prefix, directory) {
        this.staticFiles.push({ prefix, directory });
        return this;
    }
    /**
     * Register a route with a handler (internal)
     */
    registerRoute(method, path, handler) {
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
    async listen(port) {
        // Allow overriding port in listen()
        if (port !== undefined) {
            this.port = port;
        }
        try {
            // Start IPC server first
            console.log("[Zap] 🚀 Starting IPC server...");
            await this.ipcServer.start();
            // Register all handlers with IPC server
            console.log(`[Zap] 📝 Registering ${this.handlers.size} handlers...`);
            for (const [handlerId, handler] of this.handlers) {
                this.ipcServer.registerHandler(handlerId, async (req) => {
                    const result = await handler(req);
                    // Handle different response types
                    if (result instanceof Response) {
                        return {
                            status: result.status,
                            headers: Object.fromEntries(result.headers.entries()),
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
            const config = {
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
                metrics_path: this.metricsPath || undefined,
            };
            // Start Rust server process
            console.log("[Zap] 🦀 Starting Rust server process...");
            await this.processManager.start(config, this.logLevel);
            console.log(`[Zap] ✅ Server listening on http://${this.hostname}:${this.port}`);
        }
        catch (error) {
            console.error("[Zap] ❌ Failed to start server:", error);
            await this.close();
            throw error;
        }
    }
    /**
     * Close the server gracefully
     */
    async close() {
        console.log("[Zap] 🛑 Closing server...");
        try {
            await this.processManager.stop();
            await this.ipcServer.stop();
            console.log("[Zap] ✅ Server closed");
        }
        catch (error) {
            console.error("[Zap] ❌ Error closing server:", error);
            throw error;
        }
    }
    /**
     * Check if server is running
     */
    isRunning() {
        return this.processManager.isRunning();
    }
}
export default Zap;
//# sourceMappingURL=index.js.map