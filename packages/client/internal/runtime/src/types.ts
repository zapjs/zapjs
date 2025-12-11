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
  /** Unique request ID for correlation across Rust/TypeScript boundary */
  request_id: string;
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
 * Structured error response message with full context
 */
export interface ErrorMessage {
  type: 'error';
  /** Machine-readable error code (e.g., "HANDLER_ERROR", "VALIDATION_ERROR") */
  code: string;
  /** Human-readable error message */
  message: string;
  /** HTTP status code */
  status: number;
  /** Unique error identifier for log correlation */
  digest: string;
  /** Additional error-specific details */
  details?: Record<string, unknown>;
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

// ============================================================================
// Streaming Message Types (Phase 8)
// ============================================================================

/**
 * Start a streaming response
 */
export interface StreamStartMessage {
  type: 'stream_start';
  stream_id: string;
  status: number;
  headers: Record<string, string>;
}

/**
 * A chunk of streaming data
 */
export interface StreamChunkMessage {
  type: 'stream_chunk';
  stream_id: string;
  /** Base64-encoded binary data */
  data: string;
}

/**
 * End of streaming response
 */
export interface StreamEndMessage {
  type: 'stream_end';
  stream_id: string;
}

/**
 * All streaming message types
 */
export type StreamMessage = StreamStartMessage | StreamChunkMessage | StreamEndMessage;

// ============================================================================
// WebSocket Message Types (Phase 8)
// ============================================================================

/**
 * WebSocket connection opened
 */
export interface WsConnectMessage {
  type: 'ws_connect';
  connection_id: string;
  handler_id: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * WebSocket message from client
 */
export interface WsMessageMessage {
  type: 'ws_message';
  connection_id: string;
  handler_id: string;
  /** Message data (text or base64-encoded binary) */
  data: string;
  /** true if binary data */
  binary: boolean;
}

/**
 * WebSocket connection closed
 */
export interface WsCloseMessage {
  type: 'ws_close';
  connection_id: string;
  handler_id: string;
  code?: number;
  reason?: string;
}

/**
 * WebSocket message to send to client (TypeScript -> Rust)
 */
export interface WsSendMessage {
  type: 'ws_send';
  connection_id: string;
  data: string;
  binary: boolean;
}

/**
 * All WebSocket message types
 */
export type WsMessage = WsConnectMessage | WsMessageMessage | WsCloseMessage | WsSendMessage;

/**
 * All possible IPC message types (discriminated union)
 */
export type IpcMessage =
  | InvokeHandlerMessage
  | HandlerResponseMessage
  | ErrorMessage
  | HealthCheckMessage
  | HealthCheckResponseMessage
  // RPC messages
  | RpcCallMessage
  | RpcResponseMessage
  | RpcErrorMessage
  // Streaming messages (Phase 8)
  | StreamStartMessage
  | StreamChunkMessage
  | StreamEndMessage
  // WebSocket messages (Phase 8)
  | WsConnectMessage
  | WsMessageMessage
  | WsCloseMessage
  | WsSendMessage;

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
  /** Security configuration */
  security?: SecurityConfig;
  /** CORS configuration (replaces enable_cors when present) */
  cors?: CorsConfig;
}

// ============================================================================
// Security Configuration Types (Phase 10.1)
// ============================================================================

/**
 * Security headers configuration
 */
export interface SecurityHeadersConfig {
  /** Enable security headers middleware (default: true) */
  enabled?: boolean;
  /** X-Frame-Options header (default: "DENY") */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /** X-Content-Type-Options (default: "nosniff") */
  contentTypeOptions?: 'nosniff' | false;
  /** X-XSS-Protection (default: "1; mode=block") */
  xssProtection?: string | false;
  /** HSTS configuration */
  hsts?: HstsConfig | false;
  /** Content-Security-Policy (must be explicitly configured) */
  contentSecurityPolicy?: string;
  /** Referrer-Policy (default: "strict-origin-when-cross-origin") */
  referrerPolicy?: string;
}

/**
 * HTTP Strict Transport Security configuration
 */
export interface HstsConfig {
  /** max-age in seconds (default: 31536000 = 1 year) */
  maxAge?: number;
  /** Include subdomains (default: true) */
  includeSubDomains?: boolean;
  /** Preload flag (default: false) */
  preload?: boolean;
}

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Enable rate limiting (default: false) */
  enabled?: boolean;
  /** Maximum requests per window (default: 100) */
  max?: number;
  /** Time window in seconds (default: 60) */
  windowSecs?: number;
  /** Storage backend: "memory" | "redis" (default: "memory") */
  storage?: 'memory' | 'redis';
  /** Redis connection URL (required if storage is "redis") */
  redisUrl?: string;
  /** Paths to skip rate limiting */
  skipPaths?: string[];
  /** Custom error message */
  message?: string;
}

/**
 * CORS configuration (strict - no wildcard allowed)
 */
export interface CorsConfig {
  /** Allowed origins (REQUIRED - no more "*" wildcard) */
  origins: string[];
  /** Allowed methods */
  methods?: string[];
  /** Allowed headers */
  headers?: string[];
  /** Expose headers */
  exposeHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache in seconds */
  maxAge?: number;
}

/**
 * Full security configuration
 */
export interface SecurityConfig {
  /** Security headers configuration */
  headers?: SecurityHeadersConfig;
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** CORS configuration */
  cors?: CorsConfig;
}

// ============================================================================
// Observability Configuration Types (Phase 10.2)
// ============================================================================

/**
 * Observability configuration
 */
export interface ObservabilityConfig {
  /** Enable JSON logging format (default: false in dev, true in prod) */
  jsonLogs?: boolean;
  /** Metrics endpoint path (default: "/metrics", null to disable) */
  metricsPath?: string | null;
  /** Enable request ID generation/propagation (default: true) */
  enableRequestId?: boolean;
  /** Log level */
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
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
  /** Security configuration */
  security?: SecurityConfig;
  /** Observability configuration */
  observability?: ObservabilityConfig;
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

// ============================================================================
// Streaming Types (Phase 8)
// ============================================================================

/**
 * A chunk of streaming data
 */
export interface StreamChunk {
  /** String data to send */
  data?: string;
  /** Binary data to send (base64 encoded in IPC) */
  bytes?: Uint8Array;
}

/**
 * Streaming handler response - yields chunks over time
 */
export type StreamingHandler<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>,
> = (
  request: ZapRequest<TParams, TQuery>
) => AsyncIterable<StreamChunk>;

/**
 * Combined handler type that can be regular or streaming
 */
export type AnyHandler<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>,
  TResponse = unknown,
> = Handler<TParams, TQuery, TResponse> | StreamingHandler<TParams, TQuery>;

/**
 * Check if a value is an async iterable (streaming handler result)
 */
export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value
  );
}

// ============================================================================
// WebSocket Handler Types (Phase 8)
// ============================================================================

/**
 * WebSocket connection context
 */
export interface WsConnection {
  /** Unique connection ID */
  id: string;
  /** Path the WebSocket connected to */
  path: string;
  /** Headers from the initial connection */
  headers: Record<string, string>;
  /** Send a text message to the client */
  send(data: string): void;
  /** Send binary data to the client */
  sendBinary(data: Uint8Array): void;
  /** Close the connection */
  close(code?: number, reason?: string): void;
}

/**
 * WebSocket handler definition
 */
export interface WsHandler {
  /** Called when a client connects */
  onConnect?: (connection: WsConnection) => void | Promise<void>;
  /** Called when a message is received */
  onMessage?: (connection: WsConnection, message: string | Uint8Array) => void | Promise<void>;
  /** Called when the connection closes */
  onClose?: (connection: WsConnection, code?: number, reason?: string) => void | Promise<void>;
  /** Called when an error occurs */
  onError?: (connection: WsConnection, error: Error) => void | Promise<void>;
}
