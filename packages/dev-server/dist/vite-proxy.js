import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import http from 'http';
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
    config;
    process = null;
    status = 'stopped';
    actualPort = null;
    constructor(config) {
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
    getStatus() {
        return this.status;
    }
    /**
     * Get the port Vite is running on
     */
    getPort() {
        return this.actualPort;
    }
    /**
     * Start Vite dev server
     */
    async start() {
        if (this.status === 'running') {
            return;
        }
        this.status = 'starting';
        this.emit('starting');
        return new Promise((resolve, reject) => {
            const args = [
                'vite',
                '--port', String(this.config.port),
                '--host', this.config.host,
                '--strictPort',
            ];
            if (this.config.configFile) {
                args.push('--config', this.config.configFile);
            }
            // Try to use bunx first, fall back to npx
            const runner = this.detectPackageRunner();
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
                this.emit('output', output);
                // Detect when Vite is ready
                if (!startupComplete && output.includes('Local:')) {
                    startupComplete = true;
                    this.status = 'running';
                    // Parse actual port from output
                    const portMatch = output.match(/localhost:(\d+)/);
                    if (portMatch) {
                        this.actualPort = parseInt(portMatch[1], 10);
                    }
                    else {
                        this.actualPort = this.config.port;
                    }
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
                this.emit('stderr', output);
                // Check for critical errors
                if (output.includes('Error:') || output.includes('error')) {
                    this.emit('error', new Error(output));
                }
            });
            this.process.on('close', (code) => {
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
                this.status = 'error';
                this.emit('error', err);
                reject(err);
            });
            // Timeout for startup
            setTimeout(() => {
                if (!startupComplete) {
                    this.emit('timeout');
                    // Don't reject - Vite might still be starting
                }
            }, 30000);
        });
    }
    /**
     * Stop Vite dev server
     */
    async stop() {
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
    async restart() {
        await this.stop();
        await this.start();
    }
    /**
     * Check if Vite is healthy
     */
    async healthCheck() {
        if (!this.actualPort || this.status !== 'running') {
            return false;
        }
        return new Promise((resolve) => {
            const req = http.get(`http://${this.config.host}:${this.actualPort}/`, { timeout: 2000 }, (res) => {
                resolve(res.statusCode === 200);
            });
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
    detectPackageRunner() {
        // Check if bun is available
        try {
            const { execSync } = require('child_process');
            execSync('bun --version', { stdio: 'ignore' });
            return 'bunx';
        }
        catch {
            return 'npx';
        }
    }
    /**
     * Get the base URL for the Vite server
     */
    getBaseUrl() {
        if (!this.actualPort) {
            return null;
        }
        return `http://${this.config.host}:${this.actualPort}`;
    }
}
//# sourceMappingURL=vite-proxy.js.map