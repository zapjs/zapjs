/**
 * Route-level middleware for ZapJS
 * 
 * Middleware can:
 * - Protect routes (authentication/authorization)
 * - Transform data before rendering
 * - Handle redirects
 * - Log/monitor route access
 */

import type { RouteMatch } from './router.js';

export interface MiddlewareContext {
  /** Current route match */
  match: RouteMatch;
  /** URL pathname */
  pathname: string;
  /** Search params */
  search: string;
  /** Hash */
  hash: string;
  /** Navigation state */
  state?: unknown;
}

export interface MiddlewareResult {
  /** Continue to route */
  type: 'continue' | 'redirect' | 'block';
  /** Redirect path if type is 'redirect' */
  redirectTo?: string;
  /** Error to throw if type is 'block' */
  error?: Error;
  /** Data to pass to route */
  data?: Record<string, any>;
}

export type MiddlewareFunction = (context: MiddlewareContext) => Promise<MiddlewareResult> | MiddlewareResult;

export interface RouteMiddleware {
  /** Middleware name for debugging */
  name?: string;
  /** Middleware function */
  handler: MiddlewareFunction;
}

/**
 * Compose multiple middleware functions into one
 */
export function composeMiddleware(middlewares: RouteMiddleware[]): MiddlewareFunction {
  return async (context: MiddlewareContext): Promise<MiddlewareResult> => {
    for (const middleware of middlewares) {
      try {
        const result = await middleware.handler(context);
        
        if (result.type !== 'continue') {
          return result;
        }
        
        // Pass data to next middleware
        if (result.data) {
          context = { ...context, state: { ...context.state, ...result.data } };
        }
      } catch (error) {
        console.error(`Middleware ${middleware.name || 'unknown'} error:`, error);
        return {
          type: 'block',
          error: error instanceof Error ? error : new Error('Middleware error'),
        };
      }
    }
    
    return { type: 'continue' };
  };
}

/**
 * Common middleware factories
 */

/**
 * Authentication middleware
 */
export function requireAuth(
  checkAuth: () => boolean | Promise<boolean>,
  loginPath = '/login'
): RouteMiddleware {
  return {
    name: 'requireAuth',
    handler: async (context) => {
      const isAuthenticated = await checkAuth();
      
      if (!isAuthenticated) {
        return {
          type: 'redirect',
          redirectTo: `${loginPath}?redirect=${encodeURIComponent(context.pathname)}`,
        };
      }
      
      return { type: 'continue' };
    },
  };
}

/**
 * Role-based access control
 */
export function requireRole(
  roles: string[],
  getUserRoles: () => string[] | Promise<string[]>,
  forbiddenPath = '/403'
): RouteMiddleware {
  return {
    name: 'requireRole',
    handler: async (context) => {
      const userRoles = await getUserRoles();
      const hasRole = roles.some(role => userRoles.includes(role));
      
      if (!hasRole) {
        return {
          type: 'redirect',
          redirectTo: forbiddenPath,
        };
      }
      
      return { type: 'continue' };
    },
  };
}

/**
 * Logging middleware
 */
export function routeLogger(
  log: (info: { pathname: string; params: Record<string, string>; timestamp: number }) => void
): RouteMiddleware {
  return {
    name: 'routeLogger',
    handler: (context) => {
      log({
        pathname: context.pathname,
        params: context.match.params,
        timestamp: Date.now(),
      });
      
      return { type: 'continue' };
    },
  };
}

/**
 * Data preloading middleware
 */
export function preloadData<T>(
  loader: (params: Record<string, string>) => Promise<T>,
  key = 'preloadedData'
): RouteMiddleware {
  return {
    name: 'preloadData',
    handler: async (context) => {
      try {
        const data = await loader(context.match.params);
        return {
          type: 'continue',
          data: { [key]: data },
        };
      } catch (error) {
        console.error('Data preload failed:', error);
        return { type: 'continue' };
      }
    },
  };
}