import { EventEmitter } from 'events';
export interface HotReloadConfig {
    port?: number;
    host?: string;
}
export type ReloadType = 'full' | 'partial' | 'rust' | 'typescript' | 'config';
export interface ReloadMessage {
    type: 'reload' | 'update' | 'error' | 'connected';
    target?: ReloadType;
    files?: string[];
    message?: string;
    timestamp: number;
}
/**
 * HotReloadServer - WebSocket server for hot reload signaling
 *
 * Broadcasts reload signals to connected clients:
 * - Full page reload for Rust changes
 * - Partial reload for TypeScript changes (Vite HMR handles this)
 * - Config reload notifications
 */
export declare class HotReloadServer extends EventEmitter {
    private config;
    private wss;
    private httpServer;
    private clients;
    constructor(config?: HotReloadConfig);
    /**
     * Start the hot reload WebSocket server
     */
    start(): Promise<void>;
    /**
     * Stop the server
     */
    stop(): Promise<void>;
    /**
     * Broadcast a reload signal to all clients
     */
    reload(target: ReloadType, files?: string[]): void;
    /**
     * Broadcast an update signal (partial reload)
     */
    update(files: string[]): void;
    /**
     * Broadcast an error message
     */
    notifyError(errorMessage: string): void;
    /**
     * Broadcast a message to all connected clients
     */
    private broadcast;
    /**
     * Send a message to a specific client
     */
    private send;
    /**
     * Get the number of connected clients
     */
    getClientCount(): number;
    /**
     * Get the hot reload server URL
     */
    getUrl(): string;
    /**
     * Get the client script for browser injection
     */
    getClientScript(): string;
    /**
     * Get an HTML script tag for the client
     */
    getScriptTag(): string;
}
//# sourceMappingURL=hot-reload.d.ts.map