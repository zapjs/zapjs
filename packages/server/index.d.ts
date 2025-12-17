/**
 * @zap-js/server
 *
 * ZapJS Server Package - TypeScript Declarations
 * High-performance fullstack React framework with Rust backend
 */

/**
 * RPC namespace for calling server functions via IPC
 *
 * @example
 * ```typescript
 * import { rpc } from '@zap-js/server';
 *
 * const result = await rpc.call<User | ApiError>('get_user', { id: '123' });
 * if ('error' in result) {
 *   console.error(result.error);
 * } else {
 *   console.log(result.name);
 * }
 * ```
 */
export declare const rpc: {
  /**
   * Make a type-safe RPC call to a Rust server function
   * Uses IPC with MessagePack serialization for ultra-fast communication (< 1ms)
   *
   * @template T - The return type (usually a union of success type | error type)
   * @param functionName - Name of the Rust function marked with #[export]
   * @param params - Parameters to pass (must be JSON-serializable)
   * @returns Promise resolving to the function result
   *
   * @example
   * ```typescript
   * // Call a server function
   * const user = await rpc.call<User>('get_user', { id: '123' });
   *
   * // With error handling (Result<T, E> pattern)
   * const result = await rpc.call<User | ApiError>('get_user', { id: '123' });
   * if ('error' in result) {
   *   // Handle error
   * } else {
   *   // Use user data
   * }
   * ```
   */
  call<T = unknown>(functionName: string, params?: Record<string, unknown>): Promise<T>;
};

/**
 * Types namespace - Common type utilities
 */
export declare const types: {
  [key: string]: any;
};

/**
 * Request object passed to API route handlers
 */
export interface ZapRequest {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** Full path including query string */
  path: string;
  /** Path without query string */
  path_only: string;
  /** Parsed query parameters */
  query: Record<string, string>;
  /** Dynamic route parameters */
  params: Record<string, string>;
  /** HTTP headers */
  headers: Record<string, string>;
  /** Request body as string */
  body: string;
  /** Parsed cookies */
  cookies: Record<string, string>;
  /** Unique request ID for tracing */
  request_id?: string;
}

/**
 * Response object returned from API route handlers
 */
export interface ZapResponse {
  /** HTTP status code (default: 200) */
  status?: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** Response body (will be JSON.stringify'd if object) */
  body?: any;
  /** Raw response data (alternative to body) */
  data?: string;
}

/**
 * Handler function for HTTP methods in API routes
 */
export type RouteHandler = (req: ZapRequest) => Promise<ZapResponse | any> | ZapResponse | any;

/**
 * Async generator handler for streaming responses (SSE)
 */
export type StreamHandler = (req: ZapRequest) => AsyncGenerator<{ data: string }, void, unknown>;

/**
 * WebSocket connection interface
 */
export interface WsConnection {
  /** Unique connection ID */
  id: string;
  /** Send a message to the client */
  send(message: string | Uint8Array): void;
  /** Close the connection */
  close(code?: number, reason?: string): void;
}

/**
 * WebSocket handler interface
 */
export interface WsHandler {
  /** Called when a client connects */
  onConnect?: (connection: WsConnection) => Promise<void> | void;
  /** Called when a message is received */
  onMessage?: (connection: WsConnection, message: string | Uint8Array) => Promise<void> | void;
  /** Called when the connection closes */
  onClose?: (connection: WsConnection, code: number, reason: string) => Promise<void> | void;
  /** Called when an error occurs */
  onError?: (connection: WsConnection, error: Error) => Promise<void> | void;
}

/**
 * API route module exports
 */
export interface ApiRoute {
  GET?: RouteHandler | StreamHandler;
  POST?: RouteHandler;
  PUT?: RouteHandler;
  DELETE?: RouteHandler;
  PATCH?: RouteHandler;
  HEAD?: RouteHandler;
  OPTIONS?: RouteHandler;
  WEBSOCKET?: WsHandler;
}
