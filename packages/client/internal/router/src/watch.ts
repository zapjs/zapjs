/**
 * File watcher for route changes
 *
 * Uses chokidar to watch for file changes in the routes directory
 * and triggers route tree regeneration
 */

import chokidar, { FSWatcher } from 'chokidar';
import { extname } from 'path';
import type { WatchOptions, RouteTree } from './types.js';
import { RouteScanner } from './scanner.js';

const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const DEFAULT_DEBOUNCE = 100;

export class RouteWatcher {
  private watcher: FSWatcher | null = null;
  private scanner: RouteScanner;
  private options: WatchOptions;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChange = false;

  constructor(options: WatchOptions) {
    this.options = {
      debounce: DEFAULT_DEBOUNCE,
      ...options,
    };
    this.scanner = new RouteScanner({
      routesDir: options.routesDir,
      extensions: options.extensions,
      includeApi: options.includeApi,
    });
  }

  /**
   * Start watching the routes directory
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    const extensions = this.options.extensions ?? DEFAULT_EXTENSIONS;
    const patterns = extensions.map((ext) => `**/*${ext}`);

    this.watcher = chokidar.watch(patterns, {
      cwd: this.options.routesDir,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    this.watcher.on('add', (path) => this.handleChange('add', path));
    this.watcher.on('change', (path) => this.handleChange('change', path));
    this.watcher.on('unlink', (path) => this.handleChange('unlink', path));
    this.watcher.on('addDir', (path) => this.handleChange('addDir', path));
    this.watcher.on('unlinkDir', (path) => this.handleChange('unlinkDir', path));

    this.watcher.on('error', (error) => {
      console.error('[RouteWatcher] Error:', error);
    });

    // Initial scan (skip if routes are already known)
    if (!this.options.skipInitial) {
      this.triggerCallback();
    }
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get current route tree without triggering callback
   */
  scan(): RouteTree {
    return this.scanner.scan();
  }

  private handleChange(event: string, path: string): void {
    // Skip non-route files
    const ext = extname(path);
    const extensions = this.options.extensions ?? DEFAULT_EXTENSIONS;

    if (event !== 'addDir' && event !== 'unlinkDir' && !extensions.includes(ext)) {
      return;
    }

    // Skip excluded files/directories
    if (path.includes('/-') || path.startsWith('-')) {
      return;
    }

    this.pendingChange = true;
    this.scheduleCallback();
  }

  private scheduleCallback(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingChange) {
        this.pendingChange = false;
        this.triggerCallback();
      }
    }, this.options.debounce);
  }

  private async triggerCallback(): Promise<void> {
    try {
      const tree = this.scanner.scan();
      await this.options.onChange(tree);
    } catch (error) {
      console.error('[RouteWatcher] Callback error:', error);
    }
  }
}

/**
 * Convenience function to create and start a watcher
 */
export function watchRoutes(options: WatchOptions): RouteWatcher {
  const watcher = new RouteWatcher(options);
  watcher.start();
  return watcher;
}

/**
 * Watch routes and regenerate files on changes
 */
export function watchAndRegenerate(
  routesDir: string,
  outputDir: string,
  options?: Partial<Omit<WatchOptions, 'routesDir' | 'onChange'>>
): RouteWatcher {
  // Import dynamically to avoid circular dependency
  const { generateRouteTree } = require('./codegen.js');

  return watchRoutes({
    routesDir,
    ...options,
    onChange: (tree) => {
      generateRouteTree({ outputDir, routeTree: tree });
      console.log(`[RouteWatcher] Regenerated route tree (${tree.routes.length} routes, ${tree.apiRoutes.length} API routes)`);
    },
  });
}
