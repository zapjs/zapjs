/**
 * Route scanner integration for dev server
 *
 * Watches the routes directory and regenerates route tree on changes
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Route tree interface (matches @zapjs/router types)
interface RouteTree {
  routes: Array<{
    filePath: string;
    relativePath: string;
    urlPath: string;
    type: string;
    params: Array<{ name: string; index: number; catchAll: boolean }>;
    isIndex: boolean;
  }>;
  apiRoutes: Array<{
    filePath: string;
    relativePath: string;
    urlPath: string;
    type: string;
    params: Array<{ name: string; index: number; catchAll: boolean }>;
    methods?: string[];
    isIndex: boolean;
  }>;
  layouts: unknown[];
  root: unknown;
}

// Router module interface
interface RouterModule {
  scanRoutes: (routesDir: string) => RouteTree;
  generateRouteTree: (options: { outputDir: string; routeTree: RouteTree }) => void;
  watchRoutes: (options: { routesDir: string; skipInitial?: boolean; onChange: (tree: RouteTree) => void }) => { stop: () => Promise<void> };
}

export interface RouteScannerConfig {
  projectDir: string;
  routesDir?: string;
  outputDir?: string;
}

/**
 * RouteScannerRunner - Runs the route scanner and generates route tree
 */
export class RouteScannerRunner extends EventEmitter {
  private config: RouteScannerConfig;
  private routesDir: string;
  private outputDir: string;
  private watcher: any = null;

  constructor(config: RouteScannerConfig) {
    super();
    this.config = config;
    this.routesDir = config.routesDir || join(config.projectDir, 'routes');
    this.outputDir = config.outputDir || join(config.projectDir, 'src', 'generated');
  }

  /**
   * Try to load the router module
   */
  private async loadRouter(): Promise<RouterModule | null> {
    try {
      // Dynamic import using variable to prevent TypeScript from resolving at compile time
      const moduleName = '@zapjs/router';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const router = await (Function('moduleName', 'return import(moduleName)')(moduleName)) as RouterModule;
      return router;
    } catch {
      return null;
    }
  }

  /**
   * Scan routes once and generate output
   */
  async scan(): Promise<RouteTree | null> {
    if (!existsSync(this.routesDir)) {
      return null;
    }

    try {
      const router = await this.loadRouter();
      if (!router) {
        this.emit('error', new Error('@zapjs/router not installed'));
        return null;
      }

      const tree = router.scanRoutes(this.routesDir);

      // Ensure output directory exists
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      // Generate route tree
      router.generateRouteTree({
        outputDir: this.outputDir,
        routeTree: tree,
      });

      this.emit('scan-complete', tree);
      return tree;
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }

  /**
   * Start watching for route changes
   */
  async startWatching(): Promise<void> {
    if (!existsSync(this.routesDir)) {
      return;
    }

    try {
      const router = await this.loadRouter();
      if (!router) {
        return;
      }

      this.watcher = router.watchRoutes({
        routesDir: this.routesDir,
        skipInitial: true,
        onChange: (tree: RouteTree) => {
          // Ensure output directory exists
          if (!existsSync(this.outputDir)) {
            mkdirSync(this.outputDir, { recursive: true });
          }

          router.generateRouteTree({
            outputDir: this.outputDir,
            routeTree: tree,
          });

          this.emit('routes-changed', tree);
        },
      });

      this.emit('watching');
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Stop watching
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if routes directory exists
   */
  hasRoutesDir(): boolean {
    return existsSync(this.routesDir);
  }
}
