export interface DevOptions {
    port?: string;
    vitePort?: string;
    open?: boolean;
    logLevel?: string;
    release?: boolean;
    skipBuild?: boolean;
}
/**
 * Start development server with hot reload
 *
 * Orchestrates:
 * - Rust backend compilation with file watching
 * - Vite frontend dev server
 * - Automatic TypeScript binding generation
 * - Hot reload signaling
 */
export declare function devCommand(options: DevOptions): Promise<void>;
//# sourceMappingURL=dev.d.ts.map