/**
 * ZapJS React Hooks
 *
 * Custom hooks for error handling and route state management.
 * TanStack Router style API.
 */

import { useContext } from 'react';
import { RouteErrorContext, type ZapRouteError } from './error-boundary.js';

// ============================================================================
// Error Handling Hooks
// ============================================================================

/**
 * Access the current route error state
 *
 * Must be used within an errorComponent rendered by ErrorBoundary.
 * TanStack Router style hook for error component access.
 *
 * @throws Error if used outside of errorComponent context
 *
 * @example
 * ```tsx
 * // In your errorComponent
 * export function errorComponent() {
 *   const { error, reset } = useRouteError();
 *
 *   return (
 *     <div>
 *       <h1>Error: {error.message}</h1>
 *       {error.code && <p>Code: {error.code}</p>}
 *       {error.digest && <p>ID: {error.digest}</p>}
 *       <button onClick={reset}>Retry</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useRouteError(): { error: ZapRouteError; reset: () => void } {
  const context = useContext(RouteErrorContext);

  if (!context || !context.error) {
    throw new Error(
      'useRouteError must be used within an errorComponent. ' +
        'Make sure you are using this hook inside a component passed to ErrorBoundary as errorComponent prop.'
    );
  }

  return { error: context.error, reset: context.reset };
}

/**
 * Check if currently in an error state
 *
 * Safe to use anywhere - returns false if not in error context.
 * Useful for conditional rendering based on error state.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const isError = useIsErrorState();
 *
 *   if (isError) {
 *     return <div>We're showing an error</div>;
 *   }
 *
 *   return <div>Normal content</div>;
 * }
 * ```
 */
export function useIsErrorState(): boolean {
  const context = useContext(RouteErrorContext);
  return context !== null && context.error !== null;
}

/**
 * Get error state if available, otherwise null
 *
 * Safe version of useRouteError that doesn't throw.
 * Useful when you want to optionally access error state.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const errorState = useErrorState();
 *
 *   return (
 *     <div>
 *       {errorState && (
 *         <Banner type="error">{errorState.error.message}</Banner>
 *       )}
 *       <MainContent />
 *     </div>
 *   );
 * }
 * ```
 */
export function useErrorState(): { error: ZapRouteError; reset: () => void } | null {
  const context = useContext(RouteErrorContext);

  if (!context || !context.error) {
    return null;
  }

  return { error: context.error, reset: context.reset };
}

// ============================================================================
// Re-export types for convenience
// ============================================================================

export type { ZapRouteError, ErrorComponentProps, ErrorComponent } from './error-boundary.js';
