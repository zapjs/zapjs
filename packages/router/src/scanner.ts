/**
 * Route file scanner for ZapJS (TanStack style conventions)
 *
 * TanStack Router Conventions:
 * - index.tsx         → /
 * - about.tsx         → /about
 * - $param.tsx        → /:param
 * - posts.$postId.tsx → /posts/:postId
 * - _layout.tsx       → Pathless layout wrapper
 * - __root.tsx        → Root layout
 * - (group)/          → Route group (no URL segment)
 * - -excluded/        → Excluded from routing
 * - api/*.ts          → API routes (separate folder)
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import type {
  ScannedRoute,
  LayoutRoute,
  RootRoute,
  RouteTree,
  RouteParam,
  RouteType,
  ScanOptions,
  HttpMethod,
} from './types.js';

const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const API_FOLDER = 'api';
const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export class RouteScanner {
  private routesDir: string;
  private extensions: string[];
  private includeApi: boolean;

  constructor(options: ScanOptions) {
    this.routesDir = options.routesDir;
    this.extensions = options.extensions ?? DEFAULT_EXTENSIONS;
    this.includeApi = options.includeApi ?? true;
  }

  /**
   * Scan the routes directory and build a route tree
   */
  scan(): RouteTree {
    if (!existsSync(this.routesDir)) {
      return {
        root: null,
        routes: [],
        layouts: [],
        apiRoutes: [],
      };
    }

    const routes: ScannedRoute[] = [];
    const layouts: LayoutRoute[] = [];
    const apiRoutes: ScannedRoute[] = [];
    let root: RootRoute | null = null;

    this.scanDirectory(this.routesDir, '', routes, layouts, apiRoutes, (r) => {
      root = r;
    });

    // Sort routes for consistent output
    routes.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
    apiRoutes.sort((a, b) => a.urlPath.localeCompare(b.urlPath));

    return { root, routes, layouts, apiRoutes };
  }

  private scanDirectory(
    dir: string,
    pathPrefix: string,
    routes: ScannedRoute[],
    layouts: LayoutRoute[],
    apiRoutes: ScannedRoute[],
    setRoot: (root: RootRoute) => void
  ): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = join(pathPrefix, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded directories (prefixed with -)
        if (entry.name.startsWith('-')) {
          continue;
        }

        // Handle route groups (parentheses)
        if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
          // Route group - no URL segment
          this.scanDirectory(fullPath, pathPrefix, routes, layouts, apiRoutes, setRoot);
          continue;
        }

        // Handle API folder
        if (entry.name === API_FOLDER && this.includeApi) {
          this.scanApiDirectory(fullPath, '/api', apiRoutes);
          continue;
        }

        // Regular directory - add to path
        const urlSegment = this.fileNameToUrlSegment(entry.name);
        const newPrefix = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        this.scanDirectory(fullPath, newPrefix, routes, layouts, apiRoutes, setRoot);
        continue;
      }

      // Handle files
      if (!this.isRouteFile(entry.name)) {
        continue;
      }

      const baseName = this.getBaseName(entry.name);

      // Handle root layout
      if (baseName === '__root') {
        const rootLayout: RootRoute = {
          type: 'root',
          filePath: fullPath,
          relativePath,
          urlPath: '/',
          children: [],
        };
        setRoot(rootLayout);
        continue;
      }

      // Handle layouts
      if (baseName === '_layout') {
        const layout: LayoutRoute = {
          filePath: fullPath,
          relativePath,
          urlPath: this.prefixToUrl(pathPrefix),
          children: [],
        };
        layouts.push(layout);
        continue;
      }

      // Regular route
      const route = this.parseRouteFile(fullPath, relativePath, pathPrefix, baseName);
      routes.push(route);
    }
  }

  private scanApiDirectory(
    dir: string,
    urlPrefix: string,
    apiRoutes: ScannedRoute[]
  ): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(this.routesDir, fullPath);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('-')) continue;

        const urlSegment = this.fileNameToUrlSegment(entry.name);
        this.scanApiDirectory(fullPath, `${urlPrefix}/${urlSegment}`, apiRoutes);
        continue;
      }

      if (!this.isRouteFile(entry.name)) {
        continue;
      }

      const baseName = this.getBaseName(entry.name);
      const route = this.parseApiRouteFile(fullPath, relativePath, urlPrefix, baseName);
      apiRoutes.push(route);
    }
  }

  private parseRouteFile(
    filePath: string,
    relativePath: string,
    pathPrefix: string,
    baseName: string
  ): ScannedRoute {
    const params: RouteParam[] = [];
    let urlPath: string;
    let isIndex = false;

    if (baseName === 'index') {
      // Index route
      urlPath = this.prefixToUrl(pathPrefix);
      isIndex = true;
    } else {
      // Parse the base name (may have dot-separated segments)
      const segments = baseName.split('.');
      const urlSegments: string[] = [];

      let paramIndex = pathPrefix.split('/').filter(Boolean).length;

      for (const segment of segments) {
        if (segment.startsWith('$')) {
          // Dynamic segment
          const paramName = segment.slice(1);
          const isCatchAll = paramName.startsWith('...');
          const cleanName = isCatchAll ? paramName.slice(3) : paramName;

          params.push({
            name: cleanName,
            index: paramIndex,
            catchAll: isCatchAll,
          });

          urlSegments.push(isCatchAll ? `*${cleanName}` : `:${cleanName}`);
        } else {
          urlSegments.push(segment);
        }
        paramIndex++;
      }

      const base = this.prefixToUrl(pathPrefix);
      urlPath = base === '/'
        ? `/${urlSegments.join('/')}`
        : `${base}/${urlSegments.join('/')}`;
    }

    return {
      filePath,
      relativePath,
      urlPath,
      type: 'page',
      params,
      isIndex,
    };
  }

  private parseApiRouteFile(
    filePath: string,
    relativePath: string,
    urlPrefix: string,
    baseName: string
  ): ScannedRoute {
    const params: RouteParam[] = [];
    let urlPath: string;
    let isIndex = false;

    if (baseName === 'index') {
      urlPath = urlPrefix;
      isIndex = true;
    } else {
      const segments = baseName.split('.');
      const urlSegments: string[] = [];
      let paramIndex = urlPrefix.split('/').filter(Boolean).length;

      for (const segment of segments) {
        if (segment.startsWith('$')) {
          const paramName = segment.slice(1);
          const isCatchAll = paramName.startsWith('...');
          const cleanName = isCatchAll ? paramName.slice(3) : paramName;

          params.push({
            name: cleanName,
            index: paramIndex,
            catchAll: isCatchAll,
          });

          urlSegments.push(isCatchAll ? `*${cleanName}` : `:${cleanName}`);
        } else {
          urlSegments.push(segment);
        }
        paramIndex++;
      }

      urlPath = `${urlPrefix}/${urlSegments.join('/')}`;
    }

    return {
      filePath,
      relativePath,
      urlPath,
      type: 'api',
      params,
      methods: HTTP_METHODS, // Will be refined when we read the file
      isIndex,
    };
  }

  private isRouteFile(fileName: string): boolean {
    const ext = extname(fileName);
    return this.extensions.includes(ext);
  }

  private getBaseName(fileName: string): string {
    const ext = extname(fileName);
    return basename(fileName, ext);
  }

  private fileNameToUrlSegment(name: string): string {
    // Handle dynamic segments
    if (name.startsWith('$')) {
      const paramName = name.slice(1);
      if (paramName.startsWith('...')) {
        return `*${paramName.slice(3)}`;
      }
      return `:${paramName}`;
    }
    return name;
  }

  private prefixToUrl(prefix: string): string {
    if (!prefix) return '/';

    const segments = prefix.split('/').filter(Boolean);
    const urlSegments = segments.map((s) => this.fileNameToUrlSegment(s));

    return '/' + urlSegments.join('/');
  }
}

/**
 * Convenience function to scan routes
 */
export function scanRoutes(routesDir: string, options?: Partial<ScanOptions>): RouteTree {
  const scanner = new RouteScanner({
    routesDir,
    ...options,
  });
  return scanner.scan();
}

/**
 * Convert route tree to a flat list for debugging/display
 */
export function flattenRoutes(tree: RouteTree): ScannedRoute[] {
  return [...tree.routes, ...tree.apiRoutes];
}

/**
 * Get the parent layout for a route
 */
export function findParentLayout(
  route: ScannedRoute,
  layouts: LayoutRoute[]
): LayoutRoute | null {
  // Find the layout with the longest matching path prefix
  let bestMatch: LayoutRoute | null = null;
  let bestLength = -1;

  for (const layout of layouts) {
    if (route.urlPath.startsWith(layout.urlPath) && layout.urlPath.length > bestLength) {
      bestMatch = layout;
      bestLength = layout.urlPath.length;
    }
  }

  return bestMatch;
}
