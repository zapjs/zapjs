import { EventEmitter } from 'events';
export interface ViteProxyConfig {
    projectDir: string;
    port?: number;
    host?: string;
    configFile?: string;
}
export type ViteStatus = 'stopped' | 'starting' | 'running' | 'error';
/**
 * ViteProxy - Manages Vite dev server for frontend development
 *
 * Features:
 * - Automatic Vite dev server lifecycle management
 * - Port detection and configuration
 * - HMR support passthrough
 * - Error handling and restart
 */
export declare class ViteProxy extends EventEmitter {
    private config;
    private process;
    private status;
    private actualPort;
    constructor(config: ViteProxyConfig);
    /**
     * Get current status
     */
    getStatus(): ViteStatus;
    /**
     * Get the port Vite is running on
     */
    getPort(): number | null;
    /**
     * Start Vite dev server
     */
    start(): Promise<void>;
    /**
     * Stop Vite dev server
     */
    stop(): Promise<void>;
    /**
     * Restart Vite dev server
     */
    restart(): Promise<void>;
    /**
     * Check if Vite is healthy
     */
    healthCheck(): Promise<boolean>;
    /**
     * Detect the best package runner available
     */
    private detectPackageRunner;
    /**
     * Get the base URL for the Vite server
     */
    getBaseUrl(): string | null;
}
//# sourceMappingURL=vite-proxy.d.ts.map