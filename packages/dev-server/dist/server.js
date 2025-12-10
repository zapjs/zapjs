import { EventEmitter } from 'events';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { FileWatcher } from './watcher.js';
import { RustBuilder } from './rust-builder.js';
import { ViteProxy } from './vite-proxy.js';
import { CodegenRunner } from './codegen-runner.js';
import { HotReloadServer } from './hot-reload.js';
/**
 * DevServer - Unified development server orchestrator
 *
 * Coordinates all development components:
 * - Rust backend compilation with file watching
 * - Vite frontend dev server
 * - Automatic TypeScript binding generation
 * - Hot reload signaling
 *
 * Workflow:
 * 1. Initial build of Rust backend
 * 2. Generate TypeScript bindings
 * 3. Start Vite dev server
 * 4. Start hot reload WebSocket server
 * 5. Watch for file changes and orchestrate rebuilds
 */
export class DevServer extends EventEmitter {
    config;
    state;
    // Components
    watcher;
    rustBuilder;
    viteProxy;
    codegenRunner;
    hotReloadServer;
    // UI
    spinner;
    // Timing
    startTime = 0;
    constructor(config) {
        super();
        this.config = {
            rustPort: 3000,
            vitePort: 5173,
            hotReloadPort: 3001,
            logLevel: 'info',
            release: false,
            skipInitialBuild: false,
            openBrowser: false,
            ...config,
        };
        this.state = {
            phase: 'starting',
            rustReady: false,
            viteReady: false,
            lastError: null,
        };
        this.spinner = ora();
        // Initialize components
        this.watcher = new FileWatcher({
            rootDir: this.config.projectDir,
        });
        this.rustBuilder = new RustBuilder({
            projectDir: this.config.projectDir,
            release: this.config.release,
            bin: 'zap',
        });
        this.viteProxy = new ViteProxy({
            projectDir: this.config.projectDir,
            port: this.config.vitePort,
        });
        this.codegenRunner = new CodegenRunner({
            projectDir: this.config.projectDir,
        });
        this.hotReloadServer = new HotReloadServer({
            port: this.config.hotReloadPort,
        });
        this.setupEventHandlers();
    }
    /**
     * Set up event handlers for all components
     */
    setupEventHandlers() {
        // File watcher events
        this.watcher.on('rust', (event) => this.handleRustChange(event));
        this.watcher.on('typescript', (event) => this.handleTypeScriptChange(event));
        this.watcher.on('config', (event) => this.handleConfigChange(event));
        this.watcher.on('error', (err) => this.log('error', `Watcher error: ${err.message}`));
        // Rust builder events
        this.rustBuilder.on('build-start', () => {
            this.state.phase = 'rebuilding';
            this.emit('rust-build-start');
        });
        this.rustBuilder.on('build-complete', (result) => {
            this.emit('rust-build-complete', result);
        });
        this.rustBuilder.on('error', (msg) => {
            this.log('error', msg);
        });
        this.rustBuilder.on('warning', (msg) => {
            this.log('warn', msg);
        });
        // Vite events
        this.viteProxy.on('ready', (port) => {
            this.state.viteReady = true;
            this.emit('vite-ready', port);
        });
        this.viteProxy.on('error', (err) => {
            this.log('error', `Vite error: ${err.message}`);
        });
        this.viteProxy.on('hmr-update', () => {
            this.emit('hmr-update');
        });
        // Hot reload events
        this.hotReloadServer.on('client-connected', () => {
            this.log('debug', 'Hot reload client connected');
        });
        // Codegen events
        this.codegenRunner.on('complete', (result) => {
            if (result.success) {
                this.log('info', 'TypeScript bindings regenerated');
            }
        });
    }
    /**
     * Start the development server
     */
    async start() {
        this.startTime = Date.now();
        console.log(chalk.cyan('\n⚡ ZapRS Dev Server\n'));
        try {
            // Phase 1: Initial Rust build
            if (!this.config.skipInitialBuild) {
                await this.buildRust();
            }
            // Phase 2: Generate TypeScript bindings
            await this.runCodegen();
            // Phase 3: Start servers in parallel
            await Promise.all([
                this.startHotReloadServer(),
                this.startViteServer(),
            ]);
            // Phase 4: Start file watcher
            this.startWatcher();
            // Ready!
            this.state.phase = 'ready';
            this.printReadyMessage();
            // Open browser if requested
            if (this.config.openBrowser) {
                this.openBrowser();
            }
        }
        catch (err) {
            this.state.phase = 'error';
            this.state.lastError = err instanceof Error ? err.message : String(err);
            throw err;
        }
    }
    /**
     * Stop all servers gracefully
     */
    async stop() {
        this.state.phase = 'stopped';
        console.log(chalk.yellow('\n\nShutting down...'));
        await Promise.all([
            this.watcher.stop(),
            this.viteProxy.stop(),
            this.hotReloadServer.stop(),
        ]);
        this.rustBuilder.cancel();
        console.log(chalk.green('Goodbye!\n'));
    }
    /**
     * Build Rust backend
     */
    async buildRust() {
        this.spinner.start('Building Rust backend...');
        const result = await this.rustBuilder.build();
        if (result.success) {
            const duration = (result.duration / 1000).toFixed(2);
            this.spinner.succeed(`Rust build complete ${chalk.gray(`(${duration}s)`)}`);
            this.state.rustReady = true;
            if (result.warnings.length > 0) {
                console.log(chalk.yellow(`  ${result.warnings.length} warnings`));
            }
        }
        else {
            this.spinner.fail('Rust build failed');
            for (const error of result.errors) {
                console.log(chalk.red(error));
            }
            throw new Error('Rust build failed');
        }
    }
    /**
     * Run codegen to generate TypeScript bindings
     */
    async runCodegen() {
        this.spinner.start('Generating TypeScript bindings...');
        const success = await this.codegenRunner.run();
        if (success) {
            this.spinner.succeed('TypeScript bindings generated');
        }
        else {
            this.spinner.warn('Codegen skipped (binary not found)');
        }
    }
    /**
     * Start the hot reload WebSocket server
     */
    async startHotReloadServer() {
        await this.hotReloadServer.start();
        this.log('debug', `Hot reload server on port ${this.config.hotReloadPort}`);
    }
    /**
     * Start the Vite dev server
     */
    async startViteServer() {
        this.spinner.start('Starting Vite dev server...');
        try {
            await this.viteProxy.start();
            this.spinner.succeed(`Vite ready on port ${this.viteProxy.getPort()}`);
        }
        catch (err) {
            this.spinner.warn('Vite not available (frontend only)');
            this.log('debug', `Vite error: ${err}`);
        }
    }
    /**
     * Start the file watcher
     */
    startWatcher() {
        this.watcher.start();
        this.log('debug', 'File watcher started');
    }
    /**
     * Handle Rust file changes
     */
    async handleRustChange(event) {
        const relativePath = path.relative(this.config.projectDir, event.path);
        console.log(chalk.blue(`\n[${event.type}] ${relativePath}`));
        this.spinner.start('Rebuilding Rust...');
        const result = await this.rustBuilder.build();
        if (result.success) {
            const duration = (result.duration / 1000).toFixed(2);
            this.spinner.succeed(`Rust rebuild complete ${chalk.gray(`(${duration}s)`)}`);
            // Regenerate bindings
            await this.codegenRunner.run();
            // Signal hot reload
            this.hotReloadServer.reload('rust', [relativePath]);
            this.state.phase = 'ready';
        }
        else {
            this.spinner.fail('Rust build failed');
            for (const error of result.errors.slice(0, 3)) {
                console.log(chalk.red(error));
            }
            // Notify clients of error
            this.hotReloadServer.notifyError(result.errors.join('\n'));
            this.state.phase = 'error';
        }
    }
    /**
     * Handle TypeScript file changes
     */
    async handleTypeScriptChange(event) {
        const relativePath = path.relative(this.config.projectDir, event.path);
        this.log('debug', `[${event.type}] ${relativePath}`);
        // Vite HMR handles TypeScript changes automatically
        // Just emit the event for logging
        this.emit('typescript-change', event);
    }
    /**
     * Handle config file changes
     */
    async handleConfigChange(event) {
        const relativePath = path.relative(this.config.projectDir, event.path);
        console.log(chalk.yellow(`\n[config] ${relativePath}`));
        // For significant config changes, restart might be needed
        if (relativePath.includes('Cargo.toml')) {
            console.log(chalk.yellow('Cargo.toml changed - rebuilding...'));
            await this.handleRustChange(event);
        }
        else if (relativePath.includes('vite.config')) {
            console.log(chalk.yellow('Vite config changed - restarting Vite...'));
            await this.viteProxy.restart();
        }
    }
    /**
     * Print the ready message
     */
    printReadyMessage() {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
        console.log(chalk.green(`\n✓ Dev server ready in ${elapsed}s\n`));
        console.log(chalk.cyan('  Servers:'));
        console.log(chalk.white(`    ➜ API:        http://127.0.0.1:${this.config.rustPort}`));
        if (this.viteProxy.getPort()) {
            console.log(chalk.white(`    ➜ Frontend:   http://127.0.0.1:${this.viteProxy.getPort()}`));
        }
        console.log(chalk.white(`    ➜ Hot Reload: ws://127.0.0.1:${this.config.hotReloadPort}`));
        console.log(chalk.gray('\n  Press Ctrl+C to stop\n'));
        // Show keyboard shortcuts
        console.log(chalk.gray('  Shortcuts:'));
        console.log(chalk.gray('    r - Rebuild Rust'));
        console.log(chalk.gray('    c - Regenerate codegen'));
        console.log(chalk.gray('    q - Quit\n'));
        // Setup keyboard input
        this.setupKeyboardInput();
    }
    /**
     * Set up keyboard input handling
     */
    setupKeyboardInput() {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', async (key) => {
                // Ctrl+C
                if (key === '\u0003') {
                    await this.stop();
                    process.exit(0);
                }
                // 'r' - rebuild
                if (key === 'r') {
                    console.log(chalk.blue('\nManual rebuild triggered...'));
                    await this.rustBuilder.build();
                }
                // 'c' - codegen
                if (key === 'c') {
                    console.log(chalk.blue('\nRegenerating bindings...'));
                    await this.codegenRunner.run();
                }
                // 'q' - quit
                if (key === 'q') {
                    await this.stop();
                    process.exit(0);
                }
            });
        }
    }
    /**
     * Open the browser
     */
    openBrowser() {
        const url = this.viteProxy.getPort()
            ? `http://127.0.0.1:${this.viteProxy.getPort()}`
            : `http://127.0.0.1:${this.config.rustPort}`;
        const { exec } = require('child_process');
        const command = process.platform === 'darwin' ? 'open' :
            process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${command} ${url}`);
    }
    /**
     * Log a message with the appropriate level
     */
    log(level, message) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const configLevel = levels[this.config.logLevel || 'info'];
        const msgLevel = levels[level];
        if (msgLevel >= configLevel) {
            const prefix = {
                debug: chalk.gray('[debug]'),
                info: chalk.blue('[info]'),
                warn: chalk.yellow('[warn]'),
                error: chalk.red('[error]'),
            }[level];
            console.log(`${prefix} ${message}`);
        }
    }
    /**
     * Get current server state
     */
    getState() {
        return { ...this.state };
    }
}
//# sourceMappingURL=server.js.map