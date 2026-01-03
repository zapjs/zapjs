import { spawn, ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import type { ZapConfig } from '../../../packages/client/src/runtime/types';

export interface SpliceTestConfig {
  workerBinaryPath: string;
  spliceBinaryPath: string;
  zapBinaryPath: string;
  socketDir?: string;
  maxConcurrency?: number;
  timeout?: number;
  port?: number;
}

export class SpliceTestHarness {
  private config: SpliceTestConfig;
  private spliceProcess: ChildProcess | null = null;
  private zapProcess: ChildProcess | null = null;
  private spliceSocketPath: string;
  private ipcSocketPath: string;
  private configPath: string;
  private running: boolean = false;
  private port: number;

  constructor(config: SpliceTestConfig) {
    this.config = config;
    this.port = config.port || 40000 + Math.floor(Math.random() * 10000);

    const testId = Math.random().toString(36).substring(7);
    const socketDir = config.socketDir || tmpdir();
    this.spliceSocketPath = join(socketDir, `splice-test-${testId}.sock`);
    this.ipcSocketPath = join(socketDir, `ipc-test-${testId}`);
    this.configPath = join(socketDir, `zap-config-${testId}.json`);
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Harness already running');
    }

    console.log('[Test Harness] Starting Splice...');
    console.log('[Test Harness] Worker:', this.config.workerBinaryPath);
    console.log('[Test Harness] Splice socket:', this.spliceSocketPath);
    console.log('[Test Harness] IPC socket:', this.ipcSocketPath);
    console.log('[Test Harness] HTTP port:', this.port);

    // Start Splice supervisor
    await this.startSplice();

    // Create Zap config
    this.createZapConfig();

    // Start Zap server
    console.log('[Test Harness] Starting Zap server...');
    await this.startZap();

    this.running = true;
    console.log('[Test Harness] All services ready');
  }

  private async startSplice(): Promise<void> {
    const args = [
      '--socket',
      this.spliceSocketPath,
      '--worker',
      this.config.workerBinaryPath,
      '--max-concurrency',
      (this.config.maxConcurrency || 100).toString(),
      '--timeout',
      (this.config.timeout || 30).toString(),
    ];

    this.spliceProcess = spawn(this.config.spliceBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || 'info',
      },
    });

    this.spliceProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Splice] ${output}`);
      }
    });

    this.spliceProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Splice] ${output}`);
      }
    });

    this.spliceProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[Splice] Exited: code=${code}, signal=${signal}`);
      }
    });

    this.spliceProcess.on('error', (err) => {
      console.error('[Splice] Process error:', err);
    });

    await this.waitForSocket(this.spliceSocketPath, 'Splice');
    console.log('[Test Harness] Splice ready');
  }

  private createZapConfig(): void {
    const config: ZapConfig = {
      port: this.port,
      hostname: '127.0.0.1',
      ipc_socket_path: this.ipcSocketPath,
      splice_socket_path: this.spliceSocketPath,
      routes: [],
      static_files: [],
      middleware: {
        enable_cors: false,
        enable_compression: false,
        enable_logging: true,
      },
      health_check_path: '/health',
    };

    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[Test Harness] Created Zap config at:', this.configPath);
  }

  private async startZap(): Promise<void> {
    const args = ['--config', this.configPath];

    this.zapProcess = spawn(this.config.zapBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || 'info',
      },
    });

    this.zapProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Zap] ${output}`);
      }
    });

    this.zapProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Zap] ${output}`);
      }
    });

    this.zapProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[Zap] Exited: code=${code}, signal=${signal}`);
      }
    });

    this.zapProcess.on('error', (err) => {
      console.error('[Zap] Process error:', err);
    });

    // Wait for both IPC socket and HTTP server
    await this.waitForSocket(`${this.ipcSocketPath}.rpc`, 'Zap IPC');
    await this.waitForHttp();
    console.log('[Test Harness] Zap server ready');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('[Test Harness] Stopping services...');

    // Stop Zap first
    if (this.zapProcess && !this.zapProcess.killed) {
      this.zapProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!this.zapProcess.killed) {
        this.zapProcess.kill('SIGKILL');
      }
    }

    // Stop Splice
    if (this.spliceProcess && !this.spliceProcess.killed) {
      this.spliceProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!this.spliceProcess.killed) {
        this.spliceProcess.kill('SIGKILL');
      }
    }

    // Cleanup files
    this.cleanup();

    this.spliceProcess = null;
    this.zapProcess = null;
    this.running = false;

    console.log('[Test Harness] Cleanup complete');
  }

  private cleanup(): void {
    const files = [
      this.spliceSocketPath,
      `${this.ipcSocketPath}.rpc`,
      this.configPath,
    ];

    for (const file of files) {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  getSpliceSocketPath(): string {
    return this.spliceSocketPath;
  }

  getIpcSocketPath(): string {
    return this.ipcSocketPath;
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return (
      this.running &&
      this.spliceProcess !== null &&
      !this.spliceProcess.killed &&
      this.zapProcess !== null &&
      !this.zapProcess.killed
    );
  }

  private async waitForSocket(socketPath: string, name: string): Promise<void> {
    const maxWait = 10000; // 10 seconds
    const checkInterval = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (existsSync(socketPath)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error(`${name} socket not ready within timeout: ${socketPath}`);
  }

  private async waitForHttp(): Promise<void> {
    const maxWait = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('HTTP server not ready within timeout');
  }
}

/**
 * Invoke a Splice function via IPC RPC
 */
export async function invokeViaRpc<T = unknown>(
  functionName: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const { rpcCall } = await import('../../../packages/client/src/runtime/rpc-client.js');
  return rpcCall<T>(functionName, params);
}
