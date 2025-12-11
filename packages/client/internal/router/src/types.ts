/**
 * Route types for ZapJS file-based routing (Next.js style conventions)
 *
 * File naming:
 * - [param].tsx     → /:param (dynamic segment)
 * - [...slug].tsx   → /*slug (catch-all)
 * - [[...slug]].tsx → /*slug? (optional catch-all)
 */

export type RouteType = 'page' | 'api' | 'layout' | 'root';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface RouteParam {
  name: string;
  /** Position in the URL path segments */
  index: number;
  /** Whether this is a catch-all param (e.g., [...slug] or [[...slug]]) */
  catchAll: boolean;
  /** Whether this param is optional (e.g., [[...slug]]) */
  optional: boolean;
}

export interface ScannedRoute {
  /** Absolute file path */
  filePath: string;
  /** Relative path from routes directory */
  relativePath: string;
  /** Generated URL path (e.g., /posts/:id) */
  urlPath: string;
  /** Route type */
  type: RouteType;
  /** Extracted route parameters */
  params: RouteParam[];
  /** For API routes, the HTTP methods exported */
  methods?: HttpMethod[];
  /** Parent layout file path (if any) */
  layoutPath?: string;
  /** Route group name (from (group) folders) */
  group?: string;
  /** Whether this is an index route */
  isIndex: boolean;
  /** Whether this route exports an errorComponent */
  hasErrorComponent?: boolean;
  /** Export name for the error component (defaults to 'errorComponent') */
  errorComponentExport?: string;
  /** Whether this route exports a pendingComponent */
  hasPendingComponent?: boolean;
  /** Export name for the pending component */
  pendingComponentExport?: string;
  /** Whether this route exports a meta function for head management */
  hasMeta?: boolean;
  /** Whether this route exports middleware */
  hasMiddleware?: boolean;
  /** Whether this route exports generateStaticParams for SSG pre-rendering */
  hasGenerateStaticParams?: boolean;
  /** Route priority score (higher = more specific) */
  priority?: number;
}

export interface LayoutRoute {
  /** Absolute file path */
  filePath: string;
  /** Relative path from routes directory */
  relativePath: string;
  /** URL path segment this layout applies to */
  urlPath: string;
  /** Child routes */
  children: (ScannedRoute | LayoutRoute)[];
  /** Parent layout path (for nested layouts) */
  parentLayout?: string;
  /** Directory path this layout is scoped to */
  scopePath: string;
}

export interface RootRoute extends LayoutRoute {
  type: 'root';
}

export interface WebSocketRoute {
  /** Absolute file path */
  filePath: string;
  /** Relative path from routes directory */
  relativePath: string;
  /** WebSocket URL path */
  urlPath: string;
  /** Route parameters */
  params: RouteParam[];
}

export interface RouteTree {
  root: RootRoute | null;
  routes: ScannedRoute[];
  layouts: LayoutRoute[];
  apiRoutes: ScannedRoute[];
  /** WebSocket routes from ws/ folder or WEBSOCKET exports */
  wsRoutes: WebSocketRoute[];
}

export interface ScanOptions {
  /** Routes directory path */
  routesDir: string;
  /** File extensions to consider as routes */
  extensions?: string[];
  /** Whether to include API routes */
  includeApi?: boolean;
}

export interface CodegenOptions {
  /** Output directory for generated files */
  outputDir: string;
  /** Route tree to generate from */
  routeTree: RouteTree;
  /** Whether to generate React Router compatible output */
  reactRouter?: boolean;
}

export interface WatchOptions extends ScanOptions {
  /** Callback when routes change */
  onChange: (tree: RouteTree) => void | Promise<void>;
  /** Debounce delay in ms */
  debounce?: number;
  /** Skip the initial callback on start (useful when routes are already scanned) */
  skipInitial?: boolean;
}

export interface RouteMatch {
  route: ScannedRoute;
  params: Record<string, string>;
}

export interface RouteManifest {
  version: string;
  generatedAt: string;
  routes: ScannedRoute[];
  apiRoutes: ScannedRoute[];
}
