export interface ZapConfig {
    port: number;
    hostname: string;
    ipc_socket_path: string;
    max_request_body_size?: number;
    request_timeout_secs?: number;
    routes: RouteConfig[];
    static_files: StaticFileConfig[];
    middleware: MiddlewareConfig;
    health_check_path?: string;
    metrics_path?: string;
}
export interface RouteConfig {
    method: string;
    path: string;
    handler_id: string;
    is_typescript: boolean;
}
export interface StaticFileConfig {
    prefix: string;
    directory: string;
    options?: Record<string, any>;
}
export interface MiddlewareConfig {
    enable_cors?: boolean;
    enable_logging?: boolean;
    enable_compression?: boolean;
}
/**
 * ProcessManager
 *
 * Manages the lifecycle of the Rust binary process:
 * - Spawning the process with proper configuration
 * - Forwarding logs to console
 * - Monitoring for crashes
 * - Graceful shutdown with timeout
 * - Health check polling
 */
export declare class ProcessManager {
    private process;
    private configPath;
    private binaryPath;
    private socketPath;
    constructor(binaryPath?: string, socketPath?: string);
    /**
     * Find the Zap binary in common locations
     */
    private getDefaultBinaryPath;
    /**
     * Check if a binary file exists and is executable
     */
    private binaryExists;
    /**
     * Start the Rust server process
     */
    start(config: ZapConfig, logLevel?: string): Promise<void>;
    /**
     * Poll the health check endpoint until the server is ready
     */
    private waitForHealthy;
    /**
     * Stop the server process gracefully
     */
    stop(): Promise<void>;
    /**
     * Restart the server
     */
    restart(config: ZapConfig, logLevel?: string): Promise<void>;
    /**
     * Get the IPC socket path
     */
    getSocketPath(): string;
    /**
     * Check if the process is still running
     */
    isRunning(): boolean;
}
//# sourceMappingURL=process-manager.d.ts.map