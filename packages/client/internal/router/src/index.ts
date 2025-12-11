/**
 * @zapjs/router
 *
 * File-based routing for ZapJS (Next.js style conventions)
 *
 * File naming:
 * - [param].tsx     → /:param (dynamic segment)
 * - [...slug].tsx   → /*slug (catch-all)
 * - [[...slug]].tsx → /*slug? (optional catch-all)
 */

// Types
export type {
  RouteType,
  HttpMethod,
  RouteParam,
  ScannedRoute,
  LayoutRoute,
  RootRoute,
  WebSocketRoute,
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
export { generateEnhancedRouteTree } from './codegen-enhanced.js';

// Watcher
export { RouteWatcher, watchRoutes, watchAndRegenerate } from './watch.js';

// SSG (Static Site Generation)
export {
  buildSsg,
  buildPrerenderedRoutes,
  findSsgRoutes,
  collectStaticParams,
  buildPath,
  getOutputPath,
  writeSsgManifest,
  readSsgManifest,
  isStaticPath,
  getStaticRoute,
  type StaticParams,
  type GenerateStaticParamsFn,
  type PrerenderedRoute,
  type SsgManifest,
  type SsgOptions,
} from './ssg.js';
