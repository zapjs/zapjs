/**
 * @zap-js/client/errors
 * 
 * Error handling utilities
 */

import {
  ErrorBoundary,
  DefaultErrorComponent,
  createRouteError,
  ZapError,
  useRouteError,
  useIsErrorState,
  useErrorState,
} from '../internal/runtime/src/error-boundary.js';

// Errors object with all error handling utilities
const errors = {
  // Components
  Boundary: ErrorBoundary,
  DefaultComponent: DefaultErrorComponent,
  
  // Utilities
  create: createRouteError,
  ZapError,
  
  // Hooks
  useError: useRouteError,
  useIsError: useIsErrorState,
  useState: useErrorState,
};

export default errors;