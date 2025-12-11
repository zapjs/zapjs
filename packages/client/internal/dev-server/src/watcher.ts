import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import path from 'path';

export type WatchEventType = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  type: WatchEventType;
  path: string;
  category: 'rust' | 'typescript' | 'config' | 'unknown';
}

export interface WatcherConfig {
  rootDir: string;
  rustDirs?: string[];
  tsDirs?: string[];
  ignored?: string[];
}

/**
 * FileWatcher - Monitors file changes and categorizes them
 *
 * Watches for:
 * - Rust source changes (.rs, Cargo.toml)
 * - TypeScript/JS changes (.ts, .tsx, .js, .jsx)
 * - Config changes (package.json, tsconfig.json, vite.config.*)
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private config: WatcherConfig;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs: number = 100;

  constructor(config: WatcherConfig) {
    super();
    this.config = {
      rustDirs: ['src', 'packages'],
      tsDirs: ['src', 'packages'],
      ignored: [
        '**/node_modules/**',
        '**/target/**',
        '**/dist/**',
        '**/.git/**',
        '**/build/**',
        '**/*.d.ts',
      ],
      ...config,
    };
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    const watchPaths = [
      // Rust files
      path.join(this.config.rootDir, '**/*.rs'),
      path.join(this.config.rootDir, '**/Cargo.toml'),
      // TypeScript files
      path.join(this.config.rootDir, '**/*.ts'),
      path.join(this.config.rootDir, '**/*.tsx'),
      path.join(this.config.rootDir, '**/*.js'),
      path.join(this.config.rootDir, '**/*.jsx'),
      // Config files
      path.join(this.config.rootDir, '**/package.json'),
      path.join(this.config.rootDir, '**/tsconfig.json'),
      path.join(this.config.rootDir, '**/vite.config.*'),
    ];

    this.watcher = chokidar.watch(watchPaths, {
      ignored: this.config.ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    this.watcher.on('add', (filePath) => this.handleEvent('add', filePath));
    this.watcher.on('change', (filePath) => this.handleEvent('change', filePath));
    this.watcher.on('unlink', (filePath) => this.handleEvent('unlink', filePath));
    this.watcher.on('error', (error) => this.emit('error', error));
    this.watcher.on('ready', () => this.emit('ready'));
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Handle a file event with debouncing
   */
  private handleEvent(type: WatchEventType, filePath: string): void {
    // Debounce rapid changes to the same file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      const event: WatchEvent = {
        type,
        path: filePath,
        category: this.categorizeFile(filePath),
      };

      this.emit('change', event);
      this.emit(event.category, event);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Categorize a file based on its extension
   */
  private categorizeFile(filePath: string): WatchEvent['category'] {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);

    // Rust files
    if (ext === '.rs' || basename === 'Cargo.toml') {
      return 'rust';
    }

    // TypeScript/JavaScript files
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      return 'typescript';
    }

    // Config files
    if (['package.json', 'tsconfig.json'].includes(basename) ||
        basename.startsWith('vite.config.')) {
      return 'config';
    }

    return 'unknown';
  }

  /**
   * Set debounce timing
   */
  setDebounce(ms: number): void {
    this.debounceMs = ms;
  }
}
