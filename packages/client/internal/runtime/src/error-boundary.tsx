/**
 * ZapJS Error Boundary
 *
 * TanStack Router style error boundary with explicit errorComponent prop.
 * Provides structured error handling with server error correlation.
 */

import React, { Component, createContext, useContext, type ReactNode, type ErrorInfo } from 'react';

// ============================================================================
// Error Types
// ============================================================================

/**
 * Structured route error with full context
 *
 * Matches the ErrorResponse from Rust server for consistency.
 */
export interface ZapRouteError {
  /** Human-readable error message */
  message: string;
  /** Stack trace (development only) */
  stack?: string;
  /** Unique error identifier for log correlation (from server) */
  digest?: string;
  /** Machine-readable error code (e.g., "HANDLER_ERROR", "VALIDATION_ERROR") */
  code?: string;
  /** HTTP status code */
  status?: number;
  /** Additional error-specific details */
  details?: Record<string, unknown>;
}

/**
 * Props for error component
 */
export interface ErrorComponentProps {
  /** The error that was caught */
  error: ZapRouteError;
  /** Reset function to retry rendering */
  reset: () => void;
}

/**
 * Error component type (TanStack style)
 */
export type ErrorComponent = React.ComponentType<ErrorComponentProps>;

// ============================================================================
// Context
// ============================================================================

interface RouteErrorContextValue {
  error: ZapRouteError;
  reset: () => void;
}

/**
 * Context for accessing error state in error components
 */
export const RouteErrorContext = createContext<RouteErrorContextValue | null>(null);

// ============================================================================
// Error Boundary Component
// ============================================================================

interface ErrorBoundaryProps {
  /** The content to render when no error */
  children: ReactNode;
  /** Custom error component (TanStack style) */
  errorComponent?: ErrorComponent;
  /** Fallback when no errorComponent provided */
  fallback?: ReactNode;
  /** Callback when an error is caught */
  onError?: (error: ZapRouteError, errorInfo: ErrorInfo) => void;
  /** Reset keys - when these change, the boundary resets */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: ZapRouteError | null;
}

/**
 * Error Boundary with TanStack Router style errorComponent prop
 *
 * @example
 * ```tsx
 * // Route file: routes/users.$id.tsx
 * export default function UserPage() {
 *   // ... component
 * }
 *
 * export function errorComponent({ error, reset }: ErrorComponentProps) {
 *   return (
 *     <div>
 *       <h1>Failed to load user</h1>
 *       <p>{error.message}</p>
 *       {error.digest && <small>Error ID: {error.digest}</small>}
 *       <button onClick={reset}>Try Again</button>
 *     </div>
 *   );
 * }
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Convert Error to ZapRouteError
    const zapError = normalizeError(error);
    return { hasError: true, error: zapError };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const zapError = normalizeError(error);

    // Call onError callback if provided
    if (this.props.onError) {
      this.props.onError(zapError, errorInfo);
    }

    // Log error in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary] Caught error:', error);
      console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset error state when resetKeys change
    if (this.state.hasError && this.props.resetKeys) {
      const prevKeys = prevProps.resetKeys || [];
      const currentKeys = this.props.resetKeys;

      const hasChanged = currentKeys.some(
        (key, index) => key !== prevKeys[index]
      );

      if (hasChanged) {
        this.reset();
      }
    }
  }

  /**
   * Reset the error boundary state
   */
  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      const { errorComponent: CustomErrorComponent, fallback } = this.props;
      const contextValue: RouteErrorContextValue = {
        error: this.state.error,
        reset: this.reset,
      };

      // Use custom error component if provided (TanStack style)
      if (CustomErrorComponent) {
        return (
          <RouteErrorContext.Provider value={contextValue}>
            <CustomErrorComponent error={this.state.error} reset={this.reset} />
          </RouteErrorContext.Provider>
        );
      }

      // Use fallback if provided
      if (fallback) {
        return (
          <RouteErrorContext.Provider value={contextValue}>
            {fallback}
          </RouteErrorContext.Provider>
        );
      }

      // Use default error component
      return (
        <RouteErrorContext.Provider value={contextValue}>
          <DefaultErrorComponent error={this.state.error} reset={this.reset} />
        </RouteErrorContext.Provider>
      );
    }

    return this.props.children;
  }
}

// ============================================================================
// Default Error Component
// ============================================================================

/**
 * Default error fallback UI
 *
 * Shows:
 * - Error message
 * - Error code (if available)
 * - Error digest (for server errors)
 * - Stack trace (development only)
 * - "Try Again" button
 */
export function DefaultErrorComponent({ error, reset }: ErrorComponentProps): JSX.Element {
  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        {/* Error icon */}
        <div style={styles.icon}>
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        {/* Title */}
        <h1 style={styles.title}>Something went wrong</h1>

        {/* Error message */}
        <p style={styles.message}>{error.message}</p>

        {/* Error metadata */}
        <div style={styles.metadata}>
          {error.code && (
            <span style={styles.badge}>
              {error.code}
            </span>
          )}
          {error.status && (
            <span style={styles.badge}>
              {error.status}
            </span>
          )}
        </div>

        {/* Error digest for correlation */}
        {error.digest && (
          <p style={styles.digest}>
            Error ID: <code style={styles.code}>{error.digest}</code>
          </p>
        )}

        {/* Stack trace in development */}
        {isDev && error.stack && (
          <details style={styles.details}>
            <summary style={styles.summary}>Stack Trace</summary>
            <pre style={styles.stackTrace}>{error.stack}</pre>
          </details>
        )}

        {/* Reset button */}
        <button onClick={reset} style={styles.button}>
          Try Again
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '20px',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#fafafa',
    color: '#1a1a1a',
  },
  content: {
    maxWidth: '500px',
    width: '100%',
    textAlign: 'center' as const,
    padding: '40px',
    backgroundColor: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  },
  icon: {
    marginBottom: '24px',
    color: '#ef4444',
  },
  title: {
    margin: '0 0 12px 0',
    fontSize: '24px',
    fontWeight: 600,
  },
  message: {
    margin: '0 0 16px 0',
    fontSize: '16px',
    color: '#666',
    lineHeight: 1.5,
  },
  metadata: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'center',
    marginBottom: '16px',
  },
  badge: {
    display: 'inline-block',
    padding: '4px 8px',
    fontSize: '12px',
    fontWeight: 500,
    backgroundColor: '#f3f4f6',
    borderRadius: '4px',
    color: '#4b5563',
  },
  digest: {
    margin: '0 0 20px 0',
    fontSize: '13px',
    color: '#888',
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    backgroundColor: '#f3f4f6',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '12px',
  },
  details: {
    textAlign: 'left' as const,
    marginBottom: '20px',
  },
  summary: {
    cursor: 'pointer',
    fontSize: '14px',
    color: '#666',
    marginBottom: '8px',
  },
  stackTrace: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    backgroundColor: '#1a1a1a',
    color: '#f5f5f5',
    padding: '16px',
    borderRadius: '8px',
    overflow: 'auto',
    maxHeight: '200px',
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  button: {
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'white',
    backgroundColor: '#3b82f6',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize any error to ZapRouteError format
 */
function normalizeError(error: unknown): ZapRouteError {
  // Already a ZapRouteError
  if (isZapRouteError(error)) {
    return error;
  }

  // Standard Error
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      // Check for extended properties from server errors
      code: (error as { code?: string }).code,
      status: (error as { status?: number }).status,
      digest: (error as { digest?: string }).digest,
      details: (error as { details?: Record<string, unknown> }).details,
    };
  }

  // String error
  if (typeof error === 'string') {
    return { message: error };
  }

  // Unknown error type
  return { message: 'An unknown error occurred' };
}

/**
 * Type guard for ZapRouteError
 */
function isZapRouteError(error: unknown): error is ZapRouteError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/**
 * Create a ZapRouteError from server error response
 */
export function createRouteError(options: {
  message: string;
  code?: string;
  status?: number;
  digest?: string;
  details?: Record<string, unknown>;
}): ZapRouteError {
  return {
    message: options.message,
    code: options.code,
    status: options.status,
    digest: options.digest,
    details: options.details,
  };
}

/**
 * Wrap an Error with ZapRouteError metadata
 */
export class ZapError extends Error {
  code?: string;
  status?: number;
  digest?: string;
  details?: Record<string, unknown>;

  constructor(message: string, options?: Omit<ZapRouteError, 'message' | 'stack'>) {
    super(message);
    this.name = 'ZapError';
    this.code = options?.code;
    this.status = options?.status;
    this.digest = options?.digest;
    this.details = options?.details;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ZapError.prototype);
  }

  toRouteError(): ZapRouteError {
    return {
      message: this.message,
      stack: this.stack,
      code: this.code,
      status: this.status,
      digest: this.digest,
      details: this.details,
    };
  }
}
