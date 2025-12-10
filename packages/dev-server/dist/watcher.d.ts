import { EventEmitter } from 'events';
export type WatchEventType = 'add' | 'change' | 'unlink';
export interface WatchEvent {
    type: WatchEventType;
    path: string;
    category: 'rust' | 'typescript' | 'config' | 'unknown';
}
export interface WatcherConfig {
    rootDir: string;
    rustDirs?: string[];
    tsDirs?: string[];
    ignored?: string[];
}
/**
 * FileWatcher - Monitors file changes and categorizes them
 *
 * Watches for:
 * - Rust source changes (.rs, Cargo.toml)
 * - TypeScript/JS changes (.ts, .tsx, .js, .jsx)
 * - Config changes (package.json, tsconfig.json, vite.config.*)
 */
export declare class FileWatcher extends EventEmitter {
    private watcher;
    private config;
    private debounceTimers;
    private debounceMs;
    constructor(config: WatcherConfig);
    /**
     * Start watching for file changes
     */
    start(): void;
    /**
     * Stop watching
     */
    stop(): Promise<void>;
    /**
     * Handle a file event with debouncing
     */
    private handleEvent;
    /**
     * Categorize a file based on its extension
     */
    private categorizeFile;
    /**
     * Set debounce timing
     */
    setDebounce(ms: number): void;
}
//# sourceMappingURL=watcher.d.ts.map