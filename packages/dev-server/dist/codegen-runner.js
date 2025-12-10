import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { existsSync } from 'fs';
/**
 * CodegenRunner - Automatically regenerates TypeScript bindings from Rust
 *
 * Triggered when:
 * - Rust files with #[zap::export] are modified
 * - Cargo.toml changes
 * - After successful Rust build
 */
export class CodegenRunner extends EventEmitter {
    config;
    status = 'idle';
    lastGenerated = null;
    constructor(config) {
        super();
        this.config = {
            outputDir: './src/api',
            ...config,
        };
    }
    /**
     * Get current status
     */
    getStatus() {
        return this.status;
    }
    /**
     * Run codegen to regenerate TypeScript bindings
     */
    async run() {
        if (this.status === 'running') {
            return false;
        }
        this.status = 'running';
        this.emit('start');
        try {
            const binary = await this.findCodegenBinary();
            if (!binary) {
                this.status = 'failed';
                this.emit('error', new Error('zap-codegen binary not found'));
                return false;
            }
            return new Promise((resolve) => {
                const args = ['--output', this.config.outputDir];
                const proc = spawn(binary, args, {
                    cwd: this.config.projectDir,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                proc.stdout?.on('data', (data) => {
                    this.emit('output', data.toString());
                });
                proc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                    this.emit('stderr', data.toString());
                });
                proc.on('close', (code) => {
                    if (code === 0) {
                        this.status = 'success';
                        this.lastGenerated = new Date();
                        this.emit('complete', { success: true });
                        resolve(true);
                    }
                    else {
                        this.status = 'failed';
                        this.emit('complete', { success: false, error: stderr });
                        resolve(false);
                    }
                });
                proc.on('error', (err) => {
                    this.status = 'failed';
                    this.emit('error', err);
                    resolve(false);
                });
            });
        }
        catch (err) {
            this.status = 'failed';
            this.emit('error', err);
            return false;
        }
    }
    /**
     * Find the codegen binary
     */
    async findCodegenBinary() {
        // Check explicit config
        if (this.config.codegenBinary && existsSync(this.config.codegenBinary)) {
            return this.config.codegenBinary;
        }
        // Check project's target directory
        const candidates = [
            path.join(this.config.projectDir, 'target/release/zap-codegen'),
            path.join(this.config.projectDir, 'target/debug/zap-codegen'),
            // Check for architecture-specific builds
            path.join(this.config.projectDir, 'target/aarch64-apple-darwin/release/zap-codegen'),
            path.join(this.config.projectDir, 'target/x86_64-unknown-linux-gnu/release/zap-codegen'),
        ];
        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }
        // Try to find in PATH
        try {
            execSync('which zap-codegen', { stdio: 'ignore' });
            return 'zap-codegen';
        }
        catch {
            // Not in PATH
        }
        return null;
    }
    /**
     * Check if codegen is needed based on file modification times
     */
    async isStale() {
        if (!this.lastGenerated) {
            return true;
        }
        // Could implement more sophisticated staleness detection
        // by comparing Rust file mtimes with generated file mtimes
        return false;
    }
    /**
     * Get the output directory
     */
    getOutputDir() {
        return path.join(this.config.projectDir, this.config.outputDir);
    }
}
//# sourceMappingURL=codegen-runner.js.map