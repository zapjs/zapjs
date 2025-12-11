import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import http from 'http';

export interface ViteProxyConfig {
  projectDir: string;
  port?: number;
  host?: string;
  configFile?: string;
}

export type ViteStatus = 'stopped' | 'starting' | 'running' | 'error';

/**
 * ViteProxy - Manages Vite dev server for frontend development
 *
 * Features:
 * - Automatic Vite dev server lifecycle management
 * - Port detection and configuration
 * - HMR support passthrough
 * - Error handling and restart
 */
export class ViteProxy extends EventEmitter {
  private config: ViteProxyConfig;
  private process: ChildProcess | null = null;
  private status: ViteStatus = 'stopped';
  private actualPort: number | null = null;

  constructor(config: ViteProxyConfig) {
    super();
    this.config = {
      port: 5173,
      host: '127.0.0.1',
      ...config,
    };
  }

  /**
   * Get current status
   */
  getStatus(): ViteStatus {
    return this.status;
  }

  /**
   * Get the port Vite is running on
   */
  getPort(): number | null {
    return this.actualPort;
  }

  /**
   * Start Vite dev server
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      return;
    }

    this.status = 'starting';
    this.emit('starting');

    return new Promise((resolve, reject) => {
      const args = [
        'vite',
        '--port', String(this.config.port),
        '--host', this.config.host!,
        '--strictPort',
      ];

      if (this.config.configFile) {
        args.push('--config', this.config.configFile);
      }

      // Try to use bunx first, fall back to npx
      const runner = this.detectPackageRunner();

      console.log(`[vite-proxy] Starting with: ${runner} ${args.join(' ')}`);
      console.log(`[vite-proxy] Working directory: ${this.config.projectDir}`);

      this.process = spawn(runner, args, {
        cwd: this.config.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '1',
        },
      });

      let startupComplete = false;

      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log(`[vite-proxy stdout] ${output.trim()}`);
        this.emit('output', output);

        // Detect when Vite is ready - check multiple patterns
        const isReady = output.includes('Local:') ||
                       output.includes('ready in') ||
                       output.includes('VITE') && output.includes('localhost');

        if (!startupComplete && isReady) {
          startupComplete = true;
          this.status = 'running';

          // Parse actual port from output - try multiple patterns
          const portMatch = output.match(/localhost:(\d+)/) ||
                           output.match(/127\.0\.0\.1:(\d+)/) ||
                           output.match(/:(\d+)\//);
          if (portMatch) {
            this.actualPort = parseInt(portMatch[1], 10);
          } else {
            this.actualPort = this.config.port!;
          }

          console.log(`[vite-proxy] Ready on port ${this.actualPort}`);
          this.emit('ready', this.actualPort);
          resolve();
        }

        // Detect HMR updates
        if (output.includes('[vite] hmr update')) {
          this.emit('hmr-update');
        }
      });

      this.process.stderr?.on('data', (data) => {
        const output = data.toString();
        console.log(`[vite-proxy stderr] ${output.trim()}`);
        this.emit('stderr', output);

        // Check for critical errors (but not just any lowercase 'error')
        if (output.includes('Error:') || output.includes('EADDRINUSE')) {
          this.emit('error', new Error(output));
        }
      });

      this.process.on('close', (code) => {
        console.log(`[vite-proxy] Process closed with code ${code}`);
        const wasRunning = this.status === 'running';
        this.status = 'stopped';
        this.actualPort = null;
        this.process = null;

        if (wasRunning && code !== 0) {
          this.emit('crash', code);
        }

        this.emit('exit', code);

        if (!startupComplete) {
          reject(new Error(`Vite exited with code ${code} before starting`));
        }
      });

      this.process.on('error', (err) => {
        console.log(`[vite-proxy] Process error: ${err.message}`);
        this.status = 'error';
        this.emit('error', err);
        reject(err);
      });

      // Timeout for startup
      setTimeout(() => {
        if (!startupComplete) {
          console.log(`[vite-proxy] Startup timeout - still waiting...`);
          this.emit('timeout');
          // Don't reject - Vite might still be starting
        }
      }, 30000);
    });
  }

  /**
   * Stop Vite dev server
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this.status = 'stopped';
        this.actualPort = null;
        resolve();
      });

      this.process.kill('SIGTERM');
    });
  }

  /**
   * Restart Vite dev server
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Check if Vite is healthy
   */
  async healthCheck(): Promise<boolean> {
    if (!this.actualPort || this.status !== 'running') {
      return false;
    }

    return new Promise((resolve) => {
      const req = http.get(
        `http://${this.config.host}:${this.actualPort}/`,
        { timeout: 2000 },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Detect the best package runner available
   */
  private detectPackageRunner(): string {
    // Check if bun is available
    try {
      execSync('bun --version', { stdio: 'ignore' });
      return 'bunx';
    } catch {
      return 'npx';
    }
  }

  /**
   * Get the base URL for the Vite server
   */
  getBaseUrl(): string | null {
    if (!this.actualPort) {
      return null;
    }
    return `http://${this.config.host}:${this.actualPort}`;
  }
}
