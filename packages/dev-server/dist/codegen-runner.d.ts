import { EventEmitter } from 'events';
export interface CodegenConfig {
    projectDir: string;
    outputDir?: string;
    codegenBinary?: string;
}
export type CodegenStatus = 'idle' | 'running' | 'success' | 'failed';
/**
 * CodegenRunner - Automatically regenerates TypeScript bindings from Rust
 *
 * Triggered when:
 * - Rust files with #[zap::export] are modified
 * - Cargo.toml changes
 * - After successful Rust build
 */
export declare class CodegenRunner extends EventEmitter {
    private config;
    private status;
    private lastGenerated;
    constructor(config: CodegenConfig);
    /**
     * Get current status
     */
    getStatus(): CodegenStatus;
    /**
     * Run codegen to regenerate TypeScript bindings
     */
    run(): Promise<boolean>;
    /**
     * Find the codegen binary
     */
    private findCodegenBinary;
    /**
     * Check if codegen is needed based on file modification times
     */
    isStale(): Promise<boolean>;
    /**
     * Get the output directory
     */
    getOutputDir(): string;
}
//# sourceMappingURL=codegen-runner.d.ts.map