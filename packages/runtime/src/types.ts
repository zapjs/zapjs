/**
 * ZapJS Runtime Types
 *
 * Shared type definitions for the ZapJS runtime.
 * These types ensure type safety across IPC communication,
 * handlers, and request/response handling.
 */

// ============================================================================
// Request Types
// ============================================================================

/**
 * HTTP method types supported by ZapJS
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * Base request interface from IPC
 */
export interface ZapRequest<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>,
> {
  /** HTTP method */
  method: string;
  /** Full path including query string */
  path: string;
  /** Path without query string */
  path_only: string;
  /** Parsed query parameters */
  query: TQuery;
  /** Route parameters extracted from path */
  params: TParams;
  /** HTTP headers */
  headers: Record<string, string>;
  /** Request body as string */
  body: string;
  /** Parsed cookies */
  cookies: Record<string, string>;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Handler response format for IPC
 */
export interface ZapHandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Type-safe handler function
 *
 * @template TParams - Route parameter types
 * @template TQuery - Query parameter types
 * @template TResponse - Response body type
 */
export type Handler<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>,
  TResponse = unknown,
> = (
  request: ZapRequest<TParams, TQuery>
) => TResponse | Promise<TResponse>;

/**
 * Internal handler function type (used by IPC server)
 */
export type InternalHandlerFunction = (
  req: ZapRequest
) => Promise<ZapHandlerResponse>;

// ============================================================================
// IPC Message Types (Discriminated Union)
// ============================================================================

/**
 * Message to invoke a TypeScript handler
 */
export interface InvokeHandlerMessage {
  type: 'invoke_handler';
  handler_id: string;
  request: ZapRequest;
}

/**
 * Response from a handler invocation
 */
export interface HandlerResponseMessage {
  type: 'handler_response';
  handler_id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Error response message
 */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/**
 * Health check request message
 */
export interface HealthCheckMessage {
  type: 'health_check';
}

/**
 * Health check response message
 */
export interface HealthCheckResponseMessage {
  type: 'health_check_response';
}

/**
 * All possible IPC message types (discriminated union)
 */
export type IpcMessage =
  | InvokeHandlerMessage
  | HandlerResponseMessage
  | ErrorMessage
  | HealthCheckMessage
  | HealthCheckResponseMessage;

/**
 * IPC message types as string literals
 */
export type IpcMessageType = IpcMessage['type'];

// ============================================================================
// RPC Message Types
// ============================================================================

/**
 * RPC call request
 */
export interface RpcCallMessage {
  type: 'rpc_call';
  function_name: string;
  params: Record<string, unknown>;
  request_id: string;
}

/**
 * RPC successful response
 */
export interface RpcResponseMessage {
  type: 'rpc_response';
  request_id: string;
  result: unknown;
}

/**
 * RPC error response
 */
export interface RpcErrorMessage {
  type: 'rpc_error';
  request_id: string;
  error: string;
  error_type: string;
}

/**
 * All RPC message types
 */
export type RpcMessage = RpcCallMessage | RpcResponseMessage | RpcErrorMessage;

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Route configuration for Rust server
 */
export interface RouteConfig {
  method: string;
  path: string;
  handler_id: string;
  is_typescript: boolean;
}

/**
 * Static file serving options
 */
export interface StaticFileOptions {
  /** Cache-Control max-age in seconds */
  maxAge?: number;
  /** Enable directory listing */
  directoryListing?: boolean;
  /** Default file to serve for directories */
  index?: string;
  /** Enable ETag generation */
  etag?: boolean;
}

/**
 * Static file configuration
 */
export interface StaticFileConfig {
  prefix: string;
  directory: string;
  options?: StaticFileOptions;
}

/**
 * Middleware configuration
 */
export interface MiddlewareConfig {
  enable_cors?: boolean;
  enable_logging?: boolean;
  enable_compression?: boolean;
}

/**
 * Full Zap server configuration
 */
export interface ZapConfig {
  port: number;
  hostname: string;
  ipc_socket_path: string;
  max_request_body_size?: number;
  request_timeout_secs?: number;
  routes: RouteConfig[];
  static_files: StaticFileConfig[];
  middleware: MiddlewareConfig;
  health_check_path?: string;
  metrics_path?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for InvokeHandlerMessage
 */
export function isInvokeHandlerMessage(msg: IpcMessage): msg is InvokeHandlerMessage {
  return msg.type === 'invoke_handler';
}

/**
 * Type guard for HandlerResponseMessage
 */
export function isHandlerResponseMessage(msg: IpcMessage): msg is HandlerResponseMessage {
  return msg.type === 'handler_response';
}

/**
 * Type guard for ErrorMessage
 */
export function isErrorMessage(msg: IpcMessage): msg is ErrorMessage {
  return msg.type === 'error';
}

/**
 * Type guard for HealthCheckMessage
 */
export function isHealthCheckMessage(msg: IpcMessage): msg is HealthCheckMessage {
  return msg.type === 'health_check';
}

/**
 * Type guard for HealthCheckResponseMessage
 */
export function isHealthCheckResponseMessage(msg: IpcMessage): msg is HealthCheckResponseMessage {
  return msg.type === 'health_check_response';
}

/**
 * Type guard for RpcResponseMessage
 */
export function isRpcResponseMessage(msg: RpcMessage): msg is RpcResponseMessage {
  return msg.type === 'rpc_response';
}

/**
 * Type guard for RpcErrorMessage
 */
export function isRpcErrorMessage(msg: RpcMessage): msg is RpcErrorMessage {
  return msg.type === 'rpc_error';
}

// ============================================================================
// Pending Request Type (for RPC client)
// ============================================================================

/**
 * Pending RPC request tracker
 */
export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

// ============================================================================
// File Routing Types
// ============================================================================

/**
 * File-based routing configuration
 */
export interface FileRouteConfig {
  routesDir?: string;
  generatedDir?: string;
}

/**
 * Zap server options
 */
export interface ZapOptions {
  port?: number;
  hostname?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}
