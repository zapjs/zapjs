/**
 * @zapjs/router
 *
 * File-based routing for ZapJS (TanStack style conventions)
 */

// Types
export type {
  RouteType,
  HttpMethod,
  RouteParam,
  ScannedRoute,
  LayoutRoute,
  RootRoute,
  RouteTree,
  ScanOptions,
  CodegenOptions,
  WatchOptions,
  RouteMatch,
  RouteManifest,
} from './types.js';

// Scanner
export { RouteScanner, scanRoutes, flattenRoutes, findParentLayout } from './scanner.js';

// Codegen
export { generateRouteTree, generateRustManifest } from './codegen.js';

// Watcher
export { RouteWatcher, watchRoutes, watchAndRegenerate } from './watch.js';
