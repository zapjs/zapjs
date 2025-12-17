/**
 * Auto-generated client router configuration
 * DO NOT EDIT MANUALLY
 */

import { lazy, type ComponentType } from 'react';

export interface RouteDefinition {
  path: string;
  pattern: RegExp;
  paramNames: string[];
  component: React.LazyExoticComponent<ComponentType<any>>;
  isIndex: boolean;
  layoutPath?: string;
  errorComponent?: React.LazyExoticComponent<ComponentType<any>>;
  pendingComponent?: React.LazyExoticComponent<ComponentType<any>>;
}

// Route component imports
const BlogSlugRoute = lazy(() => import('../../routes/blog/[slug]'));
const BlogSlugErrorComponent = lazy(() => import('../../routes/blog/[slug]').then(m => ({ default: m.errorComponent })));
const BlogRoute = lazy(() => import('../../routes/blog/index'));
const DocsRoute = lazy(() => import('../../routes/docs'));
const IndexRoute = lazy(() => import('../../routes/index'));

/**
 * Convert route path pattern to regex
 * :param -> named capture group
 * *param -> catch-all capture group
 */
function pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let regexStr = path
    .replace(/\//g, '\\/')
    .replace(/:\w+\??/g, (match) => {
      const isOptional = match.endsWith('?');
      const name = match.slice(1).replace('?', '');
      paramNames.push(name);
      return isOptional ? '([^/]*)?' : '([^/]+)';
    })
    .replace(/\*\w+\??/g, (match) => {
      const isOptional = match.endsWith('?');
      const name = match.slice(1).replace('?', '');
      paramNames.push(name);
      return isOptional ? '(.*)?' : '(.+)';
    });
  return { pattern: new RegExp(`^${regexStr}$`), paramNames };
}

// Route definitions with pre-compiled patterns
export const routeDefinitions: RouteDefinition[] = [
  {
    path: '/blog/:slug',
    pattern: /^\/blog\/([^/]+)$/,
    paramNames: ["slug"],
    component: BlogSlugRoute,
    isIndex: false,
    errorComponent: BlogSlugErrorComponent,
  },
  {
    path: '/blog',
    pattern: /^\/blog$/,
    paramNames: [],
    component: BlogRoute,
    isIndex: true,
  },
  {
    path: '/docs',
    pattern: /^\/docs$/,
    paramNames: [],
    component: DocsRoute,
    isIndex: false,
  },
  {
    path: '/',
    pattern: /^\/$/,
    paramNames: [],
    component: IndexRoute,
    isIndex: true,
  },
];

export type RoutePath =
  | '/blog/:slug'
  | '/blog'
  | '/docs'
  | '/';

// Type-safe params for each route
export interface RouteParams {
  '/blog/:slug': { slug: string };
  '/blog': Record<string, never>;
  '/docs': Record<string, never>;
  '/': Record<string, never>;
}

// Type-safe path builders
export function blogSlugPath(slug: string): string {
  return `/blog/${slug || ''}`.replace(/\/+$/, '') || '/';
}
