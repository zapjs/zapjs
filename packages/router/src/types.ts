/**
 * Route types for ZapJS file-based routing (TanStack style)
 */

export type RouteType = 'page' | 'api' | 'layout' | 'root';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface RouteParam {
  name: string;
  /** Position in the URL path segments */
  index: number;
  /** Whether this is a catch-all param (e.g., $...rest) */
  catchAll: boolean;
}

export interface ScannedRoute {
  /** Absolute file path */
  filePath: string;
  /** Relative path from routes directory */
  relativePath: string;
  /** Generated URL path (e.g., /posts/:postId) */
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
}

export interface RootRoute extends LayoutRoute {
  type: 'root';
}

export interface RouteTree {
  root: RootRoute | null;
  routes: ScannedRoute[];
  layouts: LayoutRoute[];
  apiRoutes: ScannedRoute[];
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
