/**
 * @zap-js/client/types
 * 
 * TypeScript types for client-side features
 */

// Router types
export type {
  Router,
  RouteDefinition,
  LayoutDefinition,
  RouteMatch,
  RouterState,
  NavigateOptions,
  LinkProps,
  RouteMeta,
} from '../internal/runtime/src/router.js';

// Middleware types
export type {
  RouteMiddleware,
  MiddlewareFunction,
  MiddlewareContext,
  MiddlewareResult,
} from '../internal/runtime/src/middleware.js';

// Error types
export type {
  ZapRouteError,
  ErrorComponentProps,
  ErrorComponent,
} from '../internal/runtime/src/types.js';

// Logger types
export type {
  LogContext,
  LogLevel,
  ChildLogger,
} from '../internal/runtime/src/types.js';