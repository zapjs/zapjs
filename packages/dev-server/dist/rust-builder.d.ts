import { EventEmitter } from 'events';
export type BuildStatus = 'idle' | 'building' | 'success' | 'failed';
export interface BuildResult {
    success: boolean;
    duration: number;
    errors: string[];
    warnings: string[];
}
export interface RustBuilderConfig {
    projectDir: string;
    target?: string;
    release?: boolean;
    features?: string[];
    bin?: string;
}
/**
 * RustBuilder - Manages Rust compilation with incremental builds
 *
 * Features:
 * - Incremental compilation using cargo's built-in caching
 * - Error parsing and structured output
 * - Build queueing to prevent concurrent builds
 * - Automatic binary detection
 */
export declare class RustBuilder extends EventEmitter {
    private config;
    private currentBuild;
    private buildQueued;
    private status;
    private lastBuildResult;
    constructor(config: RustBuilderConfig);
    /**
     * Get current build status
     */
    getStatus(): BuildStatus;
    /**
     * Get last build result
     */
    getLastBuildResult(): BuildResult | null;
    /**
     * Trigger a build, queuing if one is in progress
     */
    build(): Promise<BuildResult>;
    /**
     * Run the actual cargo build
     */
    private runBuild;
    /**
     * Format a compiler message for display
     */
    private formatCompilerMessage;
    /**
     * Cancel current build if running
     */
    cancel(): void;
    /**
     * Check the project without building (faster)
     */
    check(): Promise<BuildResult>;
    /**
     * Get the path to the built binary
     */
    getBinaryPath(): string;
}
//# sourceMappingURL=rust-builder.d.ts.map