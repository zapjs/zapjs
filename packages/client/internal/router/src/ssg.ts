/**
 * Static Site Generation (SSG) for ZapJS
 *
 * Supports generateStaticParams export for pre-rendering dynamic routes at build time.
 *
 * Usage in route files:
 * ```tsx
 * // routes/posts/[id].tsx
 * export async function generateStaticParams() {
 *   const posts = await getPosts();
 *   return posts.map(post => ({ id: post.id }));
 * }
 *
 * export default function PostPage({ params }: { params: { id: string } }) {
 *   // ...
 * }
 * ```
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { RouteTree, ScannedRoute } from './types.js';

/**
 * Static params returned by generateStaticParams
 */
export type StaticParams = Record<string, string>;

/**
 * Function signature for generateStaticParams export
 */
export type GenerateStaticParamsFn = () => Promise<StaticParams[]> | StaticParams[];

/**
 * Pre-rendered route information
 */
export interface PrerenderedRoute {
  /** Original route path pattern (e.g., /posts/:id) */
  pattern: string;
  /** Concrete path (e.g., /posts/123) */
  path: string;
  /** Route params */
  params: StaticParams;
  /** File path for the static HTML */
  outputPath: string;
}

/**
 * SSG manifest written at build time
 */
export interface SsgManifest {
  version: string;
  generatedAt: string;
  routes: PrerenderedRoute[];
}

/**
 * Options for SSG generation
 */
export interface SsgOptions {
  /** Output directory for static files */
  outputDir: string;
  /** Routes directory */
  routesDir: string;
  /** Route tree from scanner */
  routeTree: RouteTree;
  /** Whether to generate HTML files (requires renderer) */
  generateHtml?: boolean;
}

/**
 * Find all routes that have generateStaticParams export
 */
export function findSsgRoutes(routeTree: RouteTree): ScannedRoute[] {
  return routeTree.routes.filter(
    (route) => route.hasGenerateStaticParams && route.params.length > 0
  );
}

/**
 * Convert route pattern to concrete path with params
 *
 * @example
 * buildPath('/posts/:id', { id: '123' }) => '/posts/123'
 * buildPath('/blog/:slug/*rest', { slug: 'hello', rest: 'a/b' }) => '/blog/hello/a/b'
 */
export function buildPath(pattern: string, params: StaticParams): string {
  let path = pattern;

  // Replace catch-all params (*param or *param?)
  path = path.replace(/\*(\w+)\??/g, (_, key) => {
    return params[key] ?? '';
  });

  // Replace regular params (:param or :param?)
  path = path.replace(/:(\w+)\??/g, (_, key) => {
    return params[key] ?? '';
  });

  // Clean up double slashes and trailing slashes
  path = path.replace(/\/+/g, '/');
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path || '/';
}

/**
 * Get output file path for a static route
 *
 * @example
 * getOutputPath('/posts/123', 'dist') => 'dist/posts/123/index.html'
 * getOutputPath('/', 'dist') => 'dist/index.html'
 */
export function getOutputPath(path: string, outputDir: string): string {
  if (path === '/') {
    return join(outputDir, 'index.html');
  }

  // Remove leading slash and add index.html
  const cleanPath = path.replace(/^\//, '');
  return join(outputDir, cleanPath, 'index.html');
}

/**
 * Load generateStaticParams from a route file
 */
export async function loadGenerateStaticParams(
  filePath: string
): Promise<GenerateStaticParamsFn | null> {
  try {
    const module = await import(filePath);
    if (typeof module.generateStaticParams === 'function') {
      return module.generateStaticParams;
    }
    return null;
  } catch (error) {
    console.error(`[SSG] Failed to load generateStaticParams from ${filePath}:`, error);
    return null;
  }
}

/**
 * Generate static params for all SSG routes
 */
export async function collectStaticParams(
  ssgRoutes: ScannedRoute[],
  routesDir: string
): Promise<Map<ScannedRoute, StaticParams[]>> {
  const results = new Map<ScannedRoute, StaticParams[]>();

  for (const route of ssgRoutes) {
    const generateFn = await loadGenerateStaticParams(route.filePath);

    if (generateFn) {
      try {
        const params = await generateFn();
        results.set(route, params);
        console.log(`[SSG] ${route.urlPath}: ${params.length} static paths`);
      } catch (error) {
        console.error(`[SSG] Error generating params for ${route.urlPath}:`, error);
        results.set(route, []);
      }
    }
  }

  return results;
}

/**
 * Build all pre-rendered routes
 */
export async function buildPrerenderedRoutes(
  options: SsgOptions
): Promise<PrerenderedRoute[]> {
  const { outputDir, routeTree } = options;

  // Find SSG routes
  const ssgRoutes = findSsgRoutes(routeTree);

  if (ssgRoutes.length === 0) {
    console.log('[SSG] No routes with generateStaticParams found');
    return [];
  }

  console.log(`[SSG] Found ${ssgRoutes.length} routes with generateStaticParams`);

  // Collect static params
  const paramsMap = await collectStaticParams(ssgRoutes, options.routesDir);

  // Build pre-rendered routes
  const prerenderedRoutes: PrerenderedRoute[] = [];

  for (const [route, paramsList] of paramsMap) {
    for (const params of paramsList) {
      const path = buildPath(route.urlPath, params);
      const outputPath = getOutputPath(path, outputDir);

      prerenderedRoutes.push({
        pattern: route.urlPath,
        path,
        params,
        outputPath,
      });
    }
  }

  console.log(`[SSG] Generated ${prerenderedRoutes.length} static paths`);

  return prerenderedRoutes;
}

/**
 * Write SSG manifest
 */
export function writeSsgManifest(
  routes: PrerenderedRoute[],
  outputDir: string
): void {
  const manifest: SsgManifest = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    routes,
  };

  const manifestPath = join(outputDir, 'ssg-manifest.json');
  ensureDir(dirname(manifestPath));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`[SSG] Wrote manifest to ${manifestPath}`);
}

/**
 * Read SSG manifest
 */
export function readSsgManifest(outputDir: string): SsgManifest | null {
  const manifestPath = join(outputDir, 'ssg-manifest.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as SsgManifest;
  } catch {
    return null;
  }
}

/**
 * Ensure directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Main SSG build function
 *
 * Called during `zap build` to generate static paths
 */
export async function buildSsg(options: SsgOptions): Promise<SsgManifest> {
  console.log('[SSG] Starting static generation...');

  // Build pre-rendered routes
  const routes = await buildPrerenderedRoutes(options);

  // Write manifest
  writeSsgManifest(routes, options.outputDir);

  const manifest: SsgManifest = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    routes,
  };

  console.log('[SSG] Static generation complete');

  return manifest;
}

/**
 * Check if a path is statically generated
 */
export function isStaticPath(path: string, manifest: SsgManifest): boolean {
  return manifest.routes.some((route) => route.path === path);
}

/**
 * Get static route info for a path
 */
export function getStaticRoute(
  path: string,
  manifest: SsgManifest
): PrerenderedRoute | null {
  return manifest.routes.find((route) => route.path === path) ?? null;
}
