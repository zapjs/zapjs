import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import stripAnsi from 'strip-ansi';
/**
 * RustBuilder - Manages Rust compilation with incremental builds
 *
 * Features:
 * - Incremental compilation using cargo's built-in caching
 * - Error parsing and structured output
 * - Build queueing to prevent concurrent builds
 * - Automatic binary detection
 */
export class RustBuilder extends EventEmitter {
    config;
    currentBuild = null;
    buildQueued = false;
    status = 'idle';
    lastBuildResult = null;
    constructor(config) {
        super();
        this.config = {
            release: false,
            ...config,
        };
    }
    /**
     * Get current build status
     */
    getStatus() {
        return this.status;
    }
    /**
     * Get last build result
     */
    getLastBuildResult() {
        return this.lastBuildResult;
    }
    /**
     * Trigger a build, queuing if one is in progress
     */
    async build() {
        // If already building, queue another build
        if (this.status === 'building') {
            this.buildQueued = true;
            return new Promise((resolve) => {
                this.once('build-complete', resolve);
            });
        }
        return this.runBuild();
    }
    /**
     * Run the actual cargo build
     */
    async runBuild() {
        const startTime = Date.now();
        this.status = 'building';
        this.emit('build-start');
        const args = ['build'];
        if (this.config.release) {
            args.push('--release');
        }
        if (this.config.bin) {
            args.push('--bin', this.config.bin);
        }
        if (this.config.target) {
            args.push('--target', this.config.target);
        }
        if (this.config.features && this.config.features.length > 0) {
            args.push('--features', this.config.features.join(','));
        }
        // Add message format for structured output
        args.push('--message-format=json');
        return new Promise((resolve) => {
            const errors = [];
            const warnings = [];
            let stderr = '';
            this.currentBuild = spawn('cargo', args, {
                cwd: this.config.projectDir,
                env: {
                    ...process.env,
                    CARGO_TERM_COLOR: 'always',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.currentBuild.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.reason === 'compiler-message') {
                            const message = msg.message;
                            if (message.level === 'error') {
                                const formatted = this.formatCompilerMessage(message);
                                errors.push(formatted);
                                this.emit('error', formatted);
                            }
                            else if (message.level === 'warning') {
                                const formatted = this.formatCompilerMessage(message);
                                warnings.push(formatted);
                                this.emit('warning', formatted);
                            }
                        }
                        else if (msg.reason === 'build-finished') {
                            // Build finished message
                        }
                        else if (msg.reason === 'compiler-artifact') {
                            this.emit('artifact', msg.target?.name);
                        }
                    }
                    catch {
                        // Not JSON, might be regular output
                        this.emit('output', line);
                    }
                }
            });
            this.currentBuild.stderr?.on('data', (data) => {
                stderr += data.toString();
                const clean = stripAnsi(data.toString()).trim();
                if (clean) {
                    this.emit('stderr', clean);
                }
            });
            this.currentBuild.on('close', (code) => {
                const duration = Date.now() - startTime;
                const success = code === 0;
                this.status = success ? 'success' : 'failed';
                this.currentBuild = null;
                const result = {
                    success,
                    duration,
                    errors,
                    warnings,
                };
                this.lastBuildResult = result;
                this.emit('build-complete', result);
                // Process queued build if any
                if (this.buildQueued) {
                    this.buildQueued = false;
                    setImmediate(() => this.runBuild());
                }
                resolve(result);
            });
            this.currentBuild.on('error', (err) => {
                const duration = Date.now() - startTime;
                this.status = 'failed';
                this.currentBuild = null;
                const result = {
                    success: false,
                    duration,
                    errors: [`Build process error: ${err.message}`],
                    warnings,
                };
                this.lastBuildResult = result;
                this.emit('build-complete', result);
                resolve(result);
            });
        });
    }
    /**
     * Format a compiler message for display
     */
    formatCompilerMessage(message) {
        const parts = [];
        if (message.rendered) {
            return stripAnsi(message.rendered);
        }
        // Fallback formatting
        if (message.message) {
            parts.push(message.message);
        }
        if (message.spans && message.spans.length > 0) {
            const span = message.spans[0];
            if (span.file_name && span.line_start) {
                parts.push(`  --> ${span.file_name}:${span.line_start}:${span.column_start}`);
            }
        }
        return parts.join('\n');
    }
    /**
     * Cancel current build if running
     */
    cancel() {
        if (this.currentBuild && !this.currentBuild.killed) {
            this.currentBuild.kill('SIGTERM');
            this.status = 'idle';
        }
        this.buildQueued = false;
    }
    /**
     * Check the project without building (faster)
     */
    async check() {
        const startTime = Date.now();
        this.status = 'building';
        const args = ['check', '--message-format=json'];
        if (this.config.bin) {
            args.push('--bin', this.config.bin);
        }
        return new Promise((resolve) => {
            const errors = [];
            const warnings = [];
            const proc = spawn('cargo', args, {
                cwd: this.config.projectDir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.reason === 'compiler-message') {
                            const message = msg.message;
                            if (message.level === 'error') {
                                errors.push(this.formatCompilerMessage(message));
                            }
                            else if (message.level === 'warning') {
                                warnings.push(this.formatCompilerMessage(message));
                            }
                        }
                    }
                    catch {
                        // Ignore non-JSON lines
                    }
                }
            });
            proc.on('close', (code) => {
                const duration = Date.now() - startTime;
                this.status = code === 0 ? 'success' : 'failed';
                resolve({
                    success: code === 0,
                    duration,
                    errors,
                    warnings,
                });
            });
        });
    }
    /**
     * Get the path to the built binary
     */
    getBinaryPath() {
        const targetDir = this.config.release ? 'release' : 'debug';
        const binName = this.config.bin || 'zap';
        if (this.config.target) {
            return path.join(this.config.projectDir, 'target', this.config.target, targetDir, binName);
        }
        return path.join(this.config.projectDir, 'target', targetDir, binName);
    }
}
//# sourceMappingURL=rust-builder.js.map