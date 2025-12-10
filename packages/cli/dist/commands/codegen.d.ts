export interface CodegenOptions {
    input?: string;
    output?: string;
}
/**
 * Generate TypeScript bindings from Rust exports
 */
export declare function codegenCommand(options: CodegenOptions): Promise<void>;
//# sourceMappingURL=codegen.d.ts.map