import { EventEmitter } from 'events';
export interface DevServerConfig {
    projectDir: string;
    rustPort?: number;
    vitePort?: number;
    hotReloadPort?: number;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    release?: boolean;
    skipInitialBuild?: boolean;
    openBrowser?: boolean;
}
interface ServerState {
    phase: 'starting' | 'building' | 'ready' | 'rebuilding' | 'error' | 'stopped';
    rustReady: boolean;
    viteReady: boolean;
    lastError: string | null;
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
export declare class DevServer extends EventEmitter {
    private config;
    private state;
    private watcher;
    private rustBuilder;
    private viteProxy;
    private codegenRunner;
    private hotReloadServer;
    private spinner;
    private startTime;
    constructor(config: DevServerConfig);
    /**
     * Set up event handlers for all components
     */
    private setupEventHandlers;
    /**
     * Start the development server
     */
    start(): Promise<void>;
    /**
     * Stop all servers gracefully
     */
    stop(): Promise<void>;
    /**
     * Build Rust backend
     */
    private buildRust;
    /**
     * Run codegen to generate TypeScript bindings
     */
    private runCodegen;
    /**
     * Start the hot reload WebSocket server
     */
    private startHotReloadServer;
    /**
     * Start the Vite dev server
     */
    private startViteServer;
    /**
     * Start the file watcher
     */
    private startWatcher;
    /**
     * Handle Rust file changes
     */
    private handleRustChange;
    /**
     * Handle TypeScript file changes
     */
    private handleTypeScriptChange;
    /**
     * Handle config file changes
     */
    private handleConfigChange;
    /**
     * Print the ready message
     */
    private printReadyMessage;
    /**
     * Set up keyboard input handling
     */
    private setupKeyboardInput;
    /**
     * Open the browser
     */
    private openBrowser;
    /**
     * Log a message with the appropriate level
     */
    private log;
    /**
     * Get current server state
     */
    getState(): ServerState;
}
export {};
//# sourceMappingURL=server.d.ts.map