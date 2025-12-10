export interface ZapOptions {
    port?: number;
    hostname?: string;
    logLevel?: "trace" | "debug" | "info" | "warn" | "error";
}
export type Handler = (request: any) => any | Promise<any>;
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
export declare class Zap {
    private processManager;
    private ipcServer;
    private handlers;
    private routes;
    private staticFiles;
    private port;
    private hostname;
    private logLevel;
    private healthCheckPath;
    private metricsPath;
    private enableCors;
    private enableLogging;
    private enableCompression;
    constructor(options?: ZapOptions);
    /**
     * Set the server port
     */
    setPort(port: number): this;
    /**
     * Set the server hostname
     */
    setHostname(hostname: string): this;
    /**
     * Enable CORS middleware
     */
    cors(): this;
    /**
     * Enable request logging middleware
     */
    logging(): this;
    /**
     * Enable response compression middleware
     */
    compression(): this;
    /**
     * Set custom health check path
     */
    healthCheck(path: string): this;
    /**
     * Set metrics endpoint path
     */
    metrics(path: string): this;
    /**
     * Register a GET route
     */
    get(path: string, handler: Handler): this;
    /**
     * Register a POST route
     */
    post(path: string, handler: Handler): this;
    /**
     * Register a PUT route
     */
    put(path: string, handler: Handler): this;
    /**
     * Register a DELETE route
     */
    delete(path: string, handler: Handler): this;
    /**
     * Register a PATCH route
     */
    patch(path: string, handler: Handler): this;
    /**
     * Register a HEAD route
     */
    head(path: string, handler: Handler): this;
    /**
     * Convenience method for GET routes that return JSON
     */
    getJson(path: string, handler: Handler): this;
    /**
     * Convenience method for POST routes that return JSON
     */
    postJson(path: string, handler: Handler): this;
    /**
     * Register static file serving
     */
    static(prefix: string, directory: string): this;
    /**
     * Register a route with a handler (internal)
     */
    private registerRoute;
    /**
     * Start the server
     */
    listen(port?: number): Promise<void>;
    /**
     * Close the server gracefully
     */
    close(): Promise<void>;
    /**
     * Check if server is running
     */
    isRunning(): boolean;
}
export default Zap;
//# sourceMappingURL=index.d.ts.map