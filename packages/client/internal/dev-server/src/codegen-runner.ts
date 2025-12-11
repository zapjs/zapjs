import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { existsSync } from 'fs';

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
export class CodegenRunner extends EventEmitter {
  private config: CodegenConfig;
  private status: CodegenStatus = 'idle';
  private lastGenerated: Date | null = null;

  constructor(config: CodegenConfig) {
    super();
    this.config = {
      outputDir: './src/generated',
      ...config,
    };
  }

  /**
   * Get current status
   */
  getStatus(): CodegenStatus {
    return this.status;
  }

  /**
   * Run codegen to regenerate TypeScript bindings
   */
  async run(): Promise<boolean> {
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
        const args = ['--output-dir', this.config.outputDir!];

        console.log(`[codegen] Running: ${binary} ${args.join(' ')}`);
        console.log(`[codegen] CWD: ${this.config.projectDir}`);

        const proc = spawn(binary, args, {
          cwd: this.config.projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        let stdout = '';

        proc.stdout?.on('data', (data) => {
          stdout += data.toString();
          console.log(`[codegen stdout] ${data.toString().trim()}`);
          this.emit('output', data.toString());
        });

        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
          console.log(`[codegen stderr] ${data.toString().trim()}`);
          this.emit('stderr', data.toString());
        });

        proc.on('close', (code) => {
          console.log(`[codegen] Process exited with code: ${code}`);
          if (stdout) console.log(`[codegen] Full stdout: ${stdout}`);
          if (stderr) console.log(`[codegen] Full stderr: ${stderr}`);

          if (code === 0) {
            this.status = 'success';
            this.lastGenerated = new Date();
            this.emit('complete', { success: true });
            resolve(true);
          } else {
            this.status = 'failed';
            this.emit('complete', { success: false, error: stderr });
            resolve(false);
          }
        });

        proc.on('error', (err) => {
          console.log(`[codegen] Process error: ${err.message}`);
          this.status = 'failed';
          this.emit('error', err);
          resolve(false);
        });
      });
    } catch (err) {
      this.status = 'failed';
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Find the codegen binary
   */
  private async findCodegenBinary(): Promise<string | null> {
    console.log(`[codegen] Looking for binary, config.codegenBinary: ${this.config.codegenBinary}`);
    console.log(`[codegen] projectDir: ${this.config.projectDir}`);

    // Check explicit config
    if (this.config.codegenBinary) {
      console.log(`[codegen] Checking explicit path: ${this.config.codegenBinary}`);
      if (existsSync(this.config.codegenBinary)) {
        console.log(`[codegen] Found at explicit path`);
        return this.config.codegenBinary;
      }
      console.log(`[codegen] Not found at explicit path`);
    }

    // Check project's bin directory first (for pre-built binaries)
    const binCandidates = [
      path.join(this.config.projectDir, 'bin/zap-codegen'),
      path.join(this.config.projectDir, 'bin/zap-codegen.exe'),
    ];

    for (const candidate of binCandidates) {
      console.log(`[codegen] Checking bin candidate: ${candidate}`);
      if (existsSync(candidate)) {
        console.log(`[codegen] Found at: ${candidate}`);
        return candidate;
      }
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
      console.log(`[codegen] Checking target candidate: ${candidate}`);
      if (existsSync(candidate)) {
        console.log(`[codegen] Found at: ${candidate}`);
        return candidate;
      }
    }

    // Try to find in PATH
    try {
      execSync('which zap-codegen', { stdio: 'ignore' });
      console.log(`[codegen] Found in PATH`);
      return 'zap-codegen';
    } catch {
      // Not in PATH
    }

    console.log(`[codegen] Binary not found anywhere`);
    return null;
  }

  /**
   * Check if codegen is needed based on file modification times
   */
  async isStale(): Promise<boolean> {
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
  getOutputDir(): string {
    return path.join(this.config.projectDir, this.config.outputDir!);
  }
}
