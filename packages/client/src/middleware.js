/**
 * @zap-js/client/middleware
 * 
 * Route middleware utilities
 */

import {
  composeMiddleware,
  requireAuth,
  requireRole,
  routeLogger,
  preloadData,
} from '../internal/runtime/src/middleware.js';

import { useMiddlewareData } from '../internal/runtime/src/router.js';

// Middleware object with all utilities
const middleware = {
  // Core function
  compose: composeMiddleware,
  
  // Pre-built middleware
  requireAuth,
  requireRole,
  routeLogger,
  preloadData,
  
  // Hook to access middleware data
  useData: useMiddlewareData,
};

export default middleware;