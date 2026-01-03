import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';

export interface SpliceManagerConfig {
  /** Path to Splice binary */
  spliceBinaryPath: string;
  /** Path to user's server binary */
  workerBinaryPath: string;
  /** Socket path for host connection */
  socketPath: string;
  /** Max concurrent requests */
  maxConcurrency?: number;
  /** Timeout in seconds */
  timeout?: number;
  /** Watch paths for hot reload */
  watchPaths?: string[];
}

/**
 * SpliceManager - DevServer component for Splice supervisor
 *
 * Manages the Splice process lifecycle:
 * - Spawns splice binary with proper args
 * - Forwards logs
 * - Monitors health
 * - Graceful shutdown
 *
 * Follows same pattern as ProcessManager but specialized for Splice
 */
export class SpliceManager extends EventEmitter {
  private config: SpliceManagerConfig;
  private process: ChildProcess | null = null;
  private running: boolean = false;

  constructor(config: SpliceManagerConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the Splice supervisor
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Splice already running');
    }

    const args = [
      '--socket',
      this.config.socketPath,
      '--worker',
      this.config.workerBinaryPath,
      '--max-concurrency',
      (this.config.maxConcurrency || 1024).toString(),
      '--timeout',
      (this.config.timeout || 30).toString(),
    ];

    if (this.config.watchPaths && this.config.watchPaths.length > 0) {
      args.push('--watch', this.config.watchPaths.join(','));
    }

    console.log('[Splice] Starting supervisor...');
    console.log('[Splice] Worker:', this.config.workerBinaryPath);
    console.log('[Splice] Socket:', this.config.socketPath);

    this.process = spawn(this.config.spliceBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || 'info',
      },
    });

    if (!this.process.stdout || !this.process.stderr) {
      throw new Error('Failed to create Splice process streams');
    }

    // Forward stdout
    this.process.stdout.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Splice] ${output}`);
      }
    });

    // Forward stderr
    this.process.stderr.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Splice] ${output}`);
      }
    });

    // Handle exit
    this.process.on('exit', (code, signal) => {
      this.running = false;
      if (code !== 0 && code !== null) {
        console.error(`[Splice] Exited: code=${code}, signal=${signal}`);
        this.emit('error', new Error(`Splice exited with code ${code}`));
      }
    });

    // Handle errors
    this.process.on('error', (err) => {
      this.running = false;
      console.error('[Splice] Process error:', err);
      this.emit('error', err);
    });

    this.running = true;
    this.emit('started');

    // Wait for socket to be ready
    await this.waitForSocket();
  }

  /**
   * Wait for Splice to create its socket file
   */
  private async waitForSocket(): Promise<void> {
    const maxWait = 5000; // 5 seconds
    const checkInterval = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (existsSync(this.config.socketPath)) {
        console.log('[Splice] Socket ready');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error('Splice socket not ready within timeout');
  }

  /**
   * Stop the Splice process
   */
  async stop(): Promise<void> {
    if (!this.process || !this.running) {
      return;
    }

    console.log('[Splice] Stopping...');

    if (!this.process.killed) {
      this.process.kill('SIGTERM');
    }

    // Wait briefly for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Force kill if still running
    if (!this.process.killed) {
      this.process.kill('SIGKILL');
    }

    this.process = null;
    this.running = false;

    // Cleanup socket file
    if (existsSync(this.config.socketPath)) {
      try {
        unlinkSync(this.config.socketPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.emit('stopped');
  }

  /**
   * Check if Splice is running
   */
  isRunning(): boolean {
    return this.running && this.process !== null && !this.process.killed;
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.config.socketPath;
  }
}
