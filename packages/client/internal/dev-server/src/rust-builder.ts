import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import stripAnsi from 'strip-ansi';

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
  /** Path to pre-built binary (skips compilation) */
  binaryPath?: string;
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
export class RustBuilder extends EventEmitter {
  private config: RustBuilderConfig;
  private currentBuild: ChildProcess | null = null;
  private buildQueued: boolean = false;
  private status: BuildStatus = 'idle';
  private lastBuildResult: BuildResult | null = null;

  constructor(config: RustBuilderConfig) {
    super();
    this.config = {
      release: false,
      ...config,
    };
  }

  /**
   * Get current build status
   */
  getStatus(): BuildStatus {
    return this.status;
  }

  /**
   * Get last build result
   */
  getLastBuildResult(): BuildResult | null {
    return this.lastBuildResult;
  }

  /**
   * Trigger a build, queuing if one is in progress
   */
  async build(): Promise<BuildResult> {
    // If using pre-built binary, skip compilation
    if (this.config.binaryPath) {
      const { existsSync } = await import('fs');
      if (existsSync(this.config.binaryPath)) {
        this.status = 'success';
        const result: BuildResult = {
          success: true,
          duration: 0,
          errors: [],
          warnings: [],
        };
        this.lastBuildResult = result;
        this.emit('build-complete', result);
        return result;
      }
    }

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
  private async runBuild(): Promise<BuildResult> {
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
      const errors: string[] = [];
      const warnings: string[] = [];
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
              } else if (message.level === 'warning') {
                const formatted = this.formatCompilerMessage(message);
                warnings.push(formatted);
                this.emit('warning', formatted);
              }
            } else if (msg.reason === 'build-finished') {
              // Build finished message
            } else if (msg.reason === 'compiler-artifact') {
              this.emit('artifact', msg.target?.name);
            }
          } catch {
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

        const result: BuildResult = {
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

        const result: BuildResult = {
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
  private formatCompilerMessage(message: any): string {
    const parts: string[] = [];

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
  cancel(): void {
    if (this.currentBuild && !this.currentBuild.killed) {
      this.currentBuild.kill('SIGTERM');
      this.status = 'idle';
    }
    this.buildQueued = false;
  }

  /**
   * Check the project without building (faster)
   */
  async check(): Promise<BuildResult> {
    const startTime = Date.now();
    this.status = 'building';

    const args = ['check', '--message-format=json'];

    if (this.config.bin) {
      args.push('--bin', this.config.bin);
    }

    return new Promise((resolve) => {
      const errors: string[] = [];
      const warnings: string[] = [];

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
              } else if (message.level === 'warning') {
                warnings.push(this.formatCompilerMessage(message));
              }
            }
          } catch {
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
  getBinaryPath(): string {
    // Return pre-built binary path if configured
    if (this.config.binaryPath) {
      return this.config.binaryPath;
    }

    const { existsSync } = require('fs');
    const binName = this.config.bin || 'zap';

    // Determine architecture-specific target directory
    const arch = process.arch === 'arm64' ? 'aarch64-apple-darwin' : `${process.arch}-${process.platform}`;

    // Check multiple candidate paths in order of preference
    const candidates: string[] = [];

    // If target is explicitly configured, try it first
    if (this.config.target) {
      candidates.push(
        path.join(this.config.projectDir, 'target', this.config.target, 'release', binName),
        path.join(this.config.projectDir, 'target', this.config.target, 'debug', binName)
      );
    }

    // Try architecture-specific paths
    candidates.push(
      path.join(this.config.projectDir, 'target', arch, 'release', binName),
      path.join(this.config.projectDir, 'target', arch, 'debug', binName)
    );

    // Try standard release/debug paths
    candidates.push(
      path.join(this.config.projectDir, 'target', 'release', binName),
      path.join(this.config.projectDir, 'target', 'debug', binName)
    );

    // Return first existing binary
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback to expected path based on config (will fail if doesn't exist)
    const targetDir = this.config.release ? 'release' : 'debug';
    return path.join(this.config.projectDir, 'target', targetDir, binName);
  }
}
