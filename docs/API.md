# Zap.js API Reference

Complete reference for all APIs offered by the Zap.js full-stack web framework.

---

## CLIENT-SIDE APIs (`@zap-js/client`)

### 1. Router API

**Purpose:** Production-grade client-side routing with nested layouts, code splitting, and middleware support.

**Access:**
```typescript
import {
  RouterProvider, useRouter, useParams, usePathname,
  useSearchParams, Link, NavLink, Outlet, Redirect
} from '@zap-js/client'
```

**What It Offers:**
- **Components:** `RouterProvider`, `Link`, `NavLink`, `Outlet`, `Redirect`
- **Hooks:** `useRouter()`, `useParams<T>()`, `usePathname()`, `useSearchParams()`, `useRouteMatch()`, `useIsPending()`
- **Router Methods:** `push()`, `replace()`, `back()`, `forward()`, `refresh()`, `prefetch()`

**Key Features:**
- Type-safe route parameters with generics
- Nested layouts for shared UI
- Automatic code splitting via lazy components
- Route-level middleware execution
- Error boundaries per route
- Built-in pending states with `useTransition`
- Prefetching support

**User Benefits:**
- Type safety prevents runtime errors with route params
- Improved performance through code splitting and prefetching
- Clean separation of concerns with middleware
- Better UX with pending states during navigation

**Example Usage:**
```typescript
import { RouterProvider, useRouter, useParams, Link } from '@zap-js/client';

// In your app
<RouterProvider routes={routes} layouts={layouts}>
  <App />
</RouterProvider>

// In a component
function UserPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();

  return (
    <div>
      <h1>User {userId}</h1>
      <Link to="/home" prefetch>Go Home</Link>
      <button onClick={() => router.push('/settings')}>Settings</button>
    </div>
  );
}
```

**Location:** `packages/client/src/router/`, `packages/client/src/runtime/router.tsx`

---

### 2. Middleware API

**Purpose:** Route-level middleware for authentication, authorization, data preloading, and logging.

**Access:**
```typescript
import {
  requireAuth, requireRole, routeLogger, preloadData,
  composeMiddleware, type RouteMiddleware, type MiddlewareContext
} from '@zap-js/client/router'
```

**What It Offers:**
- **Pre-built Factories:** `requireAuth()`, `requireRole()`, `preloadData()`, `routeLogger()`
- **Composition:** `composeMiddleware()` for chaining middleware
- **Types:** `RouteMiddleware`, `MiddlewareContext`, `MiddlewareResult`

**Middleware Results:**
- `continue` - Allow navigation
- `redirect` - Redirect to different path
- `block` - Block with error

**Core Types:**
```typescript
interface MiddlewareContext {
  match: RouteMatch;      // Current route match
  pathname: string;       // URL pathname
  search: string;         // Search params
  hash: string;           // Hash
  state?: unknown;        // Navigation state
}

interface MiddlewareResult {
  type: 'continue' | 'redirect' | 'block';
  redirectTo?: string;    // Path to redirect to
  error?: Error;          // Error to throw
  data?: Record<string, any>;  // Data to pass to route
}

interface RouteMiddleware {
  name?: string;
  handler: MiddlewareFunction;
}
```

**Key Features:**
- Runs before route component renders
- Access to full route context (params, query, state)
- Can redirect unauthorized users
- Preload data before rendering
- Composable pipeline

**User Benefits:**
- Protect routes without cluttering components
- Better UX with data preloading
- Centralized authentication/authorization logic
- Request monitoring and logging

**Example Usage:**
```typescript
const middleware = [
  requireAuth(
    async () => {
      const session = await getSession();
      return !!session;
    },
    '/login'
  ),
  preloadData(
    async (params) => {
      return fetch(`/api/users/${params.id}`).then(r => r.json());
    },
    'userData'
  ),
];

function UserRoute() {
  const userData = useMiddlewareData();
  return <UserProfile data={userData} />;
}
```

**Location:** `packages/client/src/runtime/middleware.ts`

---

### 3. Error Handling API

**Purpose:** Structured error handling with route-level error boundaries and custom error components.

**Access:**
```typescript
import {
  ErrorBoundary, DefaultErrorComponent, ZapError,
  createRouteError, useRouteError, useIsErrorState,
  type ZapRouteError, type ErrorComponentProps
} from '@zap-js/client'
```

**What It Offers:**
- **Components:** `ErrorBoundary`, `DefaultErrorComponent`
- **Error Class:** `ZapError` with metadata (code, status, digest)
- **Hooks:** `useRouteError()`, `useIsErrorState()`, `useErrorState()`
- **Factory:** `createRouteError()`

**Error Structure:**
```typescript
interface ZapRouteError {
  message: string;          // Human-readable
  stack?: string;           // Dev only
  code?: string;            // Machine-readable (e.g., "HANDLER_ERROR")
  status?: number;          // HTTP status
  digest?: string;          // Server correlation ID
  details?: Record<string, unknown>;
}

type ErrorComponent = React.ComponentType<{
  error: ZapRouteError;
  reset: () => void;
}>
```

**Key Features:**
- Route-level error catching
- Custom error components per route
- Server error correlation via digest
- Stack traces in development
- Reset/retry functionality

**User Benefits:**
- Better debugging with correlation IDs
- Custom error UI per route
- Type-safe error handling
- Unified error handling across client and server

**Example Usage:**
```typescript
// In a route file
export default function UserPage() {
  const user = useParams<{ userId: string }>();
  return <h1>User {user.userId}</h1>;
}

// Custom error component
export const errorComponent: ErrorComponent = ({ error, reset }) => (
  <div>
    <h1>Failed to load user</h1>
    <p>{error.message}</p>
    {error.code && <p>Code: {error.code}</p>}
    {error.digest && <p>Error ID: {error.digest}</p>}
    <button onClick={reset}>Try Again</button>
  </div>
);

// Or use within error components
function ErrorUI() {
  const { error, reset } = useRouteError();
  return <div>{error.message}</div>;
}
```

**Location:** `packages/client/src/runtime/error-boundary.tsx`

---

### 4. Logger API

**Purpose:** Structured JSON logging for observability and debugging.

**Access:**
```typescript
import {
  logger, Logger,
  type LogContext, type LogLevel
} from '@zap-js/client'
```

**What It Offers:**
- **Log Levels:** `trace`, `debug`, `info`, `warn`, `error`
- **Methods:** `logger.info()`, `logger.error()`, `logger.child()`
- **Context:** Request correlation, timing, custom fields

**Core Interface:**
```typescript
interface LogContext {
  request_id?: string;      // Request correlation ID
  handler_id?: string;      // Handler that processed request
  method?: string;          // HTTP method
  path?: string;            // URL path
  duration_ms?: number;     // Request duration
  status?: number;          // HTTP status
  [key: string]: unknown;   // Additional custom fields
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
```

**Logger Methods:**
```typescript
logger.trace(message, context?)          // Lowest priority
logger.debug(message, context?)
logger.info(message, context?)
logger.warn(message, context?)
logger.error(message, context?, error?)  // Highest priority

// Child loggers inherit parent context
logger.child(baseContext)                // Returns ChildLogger
```

**Configuration:**
- `ZAP_JSON_LOGS=true` - Enable JSON output (default: false)
- `ZAP_LOG_LEVEL=debug` - Set minimum log level (default: info)

**Key Features:**
- Structured JSON or human-readable output
- Request correlation IDs
- Child loggers with inherited context
- Automatic error stack trace capture
- Performance metrics tracking

**User Benefits:**
- Production observability with JSON logs
- Request tracing across Rust/TypeScript boundary
- Environment-based formatting
- Easy integration with log aggregation tools

**Example Usage:**
```typescript
// Global logger
logger.info('Server started', { port: 3000, hostname: 'localhost' });

logger.error('Request failed',
  {
    request_id: 'req-123',
    method: 'POST',
    path: '/api/users',
    duration_ms: 1234,
    status: 500
  },
  error
);

// Child logger with pre-set context
const requestLogger = logger.child({ request_id: 'req-456', method: 'GET' });
requestLogger.info('Processing request', { path: '/api/data' });
requestLogger.warn('Cache miss', { key: 'user:123' });
```

**Location:** `packages/client/src/runtime/logger.ts`

---

### 5. WebSockets API

**Purpose:** Real-time bidirectional communication with typed WebSocket handlers and utility functions.

**Access:**
```typescript
import { websockets } from '@zap-js/client'
import type { WsConnection, WsHandler, WsMessage } from '@zap-js/client'
```

**What It Offers:**
- **Utilities:** `broadcast()`, `broadcastExcept()`, `sendJson()`, `parseMessage()`
- **Helpers:** `createErrorMessage()`, `createSuccessMessage()`, `isWsMessage()`
- **Types:** `WsConnection`, `WsHandler`, `WsMessage`

**Core Types:**
```typescript
interface WsConnection {
  id: string;                    // Unique connection ID
  path: string;                  // WebSocket endpoint path
  headers: Record<string, string>;
  send(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface WsHandler {
  onConnect?: (connection: WsConnection) => void | Promise<void>;
  onMessage?: (connection: WsConnection, message: string | Uint8Array) => void | Promise<void>;
  onClose?: (connection: WsConnection, code?: number, reason?: string) => void | Promise<void>;
  onError?: (connection: WsConnection, error: Error) => void | Promise<void>;
}
```

**Utility Functions:**

```typescript
// Broadcast to multiple connections
websockets.broadcast(
  connections: WsConnection[],
  data: string | Record<string, any>,
  options?: { exclude?: string[]; binary?: boolean }
): void

// Broadcast to all except sender
websockets.broadcastExcept(
  connections: WsConnection[],
  senderId: string,
  data: string | Record<string, any>
): void

// Send JSON message
websockets.sendJson(
  connection: WsConnection,
  data: Record<string, any>
): void

// Parse incoming message
websockets.parseMessage(
  message: string | Uint8Array
): string | any

// Create formatted responses
websockets.createErrorMessage(error: string | Error): string
websockets.createSuccessMessage(data: any): string

// Type guard
websockets.isWsMessage(msg: any): msg is WsMessage
```

**Key Features:**
- Connection management with unique IDs
- Broadcasting to multiple clients
- JSON message helpers
- Binary message support
- Type-safe message parsing

**User Benefits:**
- Simplified real-time communication
- Type-safe WebSocket handlers
- Built-in broadcast patterns
- Easy JSON messaging

**Example Usage:**
```typescript
import { websockets } from '@zap-js/client'
import type { WsConnection, WsHandler } from '@zap-js/client'

const connections = new Map<string, WsConnection>();

export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    connections.set(connection.id, connection);

    // Send welcome message
    websockets.sendJson(connection, {
      type: 'connected',
      id: connection.id,
      totalClients: connections.size
    });

    // Notify others
    websockets.broadcastExcept(
      Array.from(connections.values()),
      connection.id,
      { type: 'user_joined', userId: connection.id }
    );
  },

  onMessage: async (connection, message) => {
    const parsed = websockets.parseMessage(message);

    // Broadcast to all
    websockets.broadcast(
      Array.from(connections.values()),
      { type: 'message', from: connection.id, data: parsed }
    );
  },

  onClose: async (connection) => {
    connections.delete(connection.id);

    websockets.broadcast(
      Array.from(connections.values()),
      { type: 'user_left', userId: connection.id }
    );
  },

  onError: async (connection, error) => {
    connection.send(websockets.createErrorMessage(error));
  }
};
```

**Location:** `packages/client/src/runtime/websockets-utils.ts`

---

### 6. Streaming API

**Purpose:** Server-sent streaming responses with async iterables and utility functions for common streaming patterns.

**Access:**
```typescript
import { streaming } from '@zap-js/client'
import type { StreamChunk, StreamingHandler } from '@zap-js/client'
```

**What It Offers:**
- **Creators:** `createChunk()`, `createStream()`, `streamJson()`, `streamSSE()`
- **Transformers:** `mapStream()`, `filterStream()`, `batchStream()`, `delayStream()`
- **Converters:** `fromReadableStream()`, `intervalStream()`
- **Type Guard:** `isAsyncIterable()`

**Core Types:**
```typescript
interface StreamChunk {
  data?: string;        // String data
  bytes?: Uint8Array;   // Binary data
}

type StreamingHandler<TParams, TQuery> = (
  request: ZapRequest<TParams, TQuery>
) => AsyncIterable<StreamChunk>;
```

**Utility Functions:**

```typescript
// Create chunks
streaming.createChunk(data: string): StreamChunk
streaming.createChunk(bytes: Uint8Array): StreamChunk

// Stream creators
streaming.createStream(
  items: string[],
  delimiter?: string
): AsyncIterable<StreamChunk>

streaming.streamJson<T>(objects: T[]): AsyncIterable<StreamChunk>

streaming.streamSSE(events: Array<{
  data: any;
  event?: string;
  id?: string | number;
  retry?: number;
}>): AsyncIterable<StreamChunk>

// Stream transformers
streaming.mapStream<T, U>(
  source: AsyncIterable<T>,
  mapper: (item: T) => U | Promise<U>
): AsyncIterable<U>

streaming.filterStream<T>(
  source: AsyncIterable<T>,
  predicate: (item: T) => boolean | Promise<boolean>
): AsyncIterable<T>

streaming.batchStream<T>(
  source: AsyncIterable<T>,
  batchSize: number
): AsyncIterable<T[]>

streaming.delayStream<T>(
  source: AsyncIterable<T>,
  delayMs: number
): AsyncIterable<T>

// Converters
streaming.fromReadableStream<T>(
  stream: ReadableStream<T>
): AsyncIterable<T>

streaming.intervalStream<T>(
  interval: number,
  generator: (count: number) => T,
  maxCount?: number
): AsyncIterable<StreamChunk>

// Type guard
streaming.isAsyncIterable<T>(value: unknown): value is AsyncIterable<T>
```

**Key Features:**
- Async generator-based streaming
- NDJSON (newline-delimited JSON) support
- Server-Sent Events (SSE) format
- Stream transformation pipelines
- Interval-based streaming
- ReadableStream compatibility

**User Benefits:**
- Simple API for complex streaming
- Composable stream transformations
- Support for multiple streaming formats
- Type-safe async iteration

**Example Usage:**

```typescript
import { streaming } from '@zap-js/client'

// Stream JSON objects
export async function GET() {
  const users = await fetchUsers();
  return streaming.streamJson(users);
}

// Stream with transformations
export async function* GET() {
  const source = await getDataStream();

  // Transform and filter
  yield* streaming.filterStream(
    streaming.mapStream(source, item => ({
      ...item,
      processed: true
    })),
    item => item.value > 100
  );
}

// Server-Sent Events
export async function GET() {
  return streaming.streamSSE([
    { data: { count: 1 }, event: 'counter', id: 1 },
    { data: { count: 2 }, event: 'counter', id: 2 },
    { data: { count: 3 }, event: 'counter', id: 3 }
  ]);
}

// Interval streaming
export async function GET() {
  return streaming.intervalStream(
    1000,  // Every 1 second
    (count) => ({ time: Date.now(), count }),
    10     // Max 10 emissions
  );
}

// Batched streaming
export async function* GET() {
  const largeDataset = await fetchLargeDataset();

  // Send in batches of 100
  yield* streaming.batchStream(
    streaming.createStream(largeDataset.map(JSON.stringify)),
    100
  );
}
```

**Location:** `packages/client/src/runtime/streaming-utils.ts`

---

### 7. Types Export

**Purpose:** Comprehensive TypeScript definitions for type safety.

**Access:**
```typescript
import type {
  Handler, ZapRequest, ZapHandlerResponse, ZapConfig,
  RouteConfig, WsHandler, IpcMessage, StreamChunk
} from '@zap-js/client'
```

**What It Offers:**
- **Request/Response:** `ZapRequest<TParams, TQuery>`, `ZapHandlerResponse`
- **Handlers:** `Handler<>`, `StreamingHandler<>`, `WsHandler`
- **Configuration:** `ZapConfig`, `SecurityConfig`, `CorsConfig`, `RateLimitConfig`
- **IPC Protocol:** `IpcMessage` union (12+ message types)
- **Type Guards:** `isInvokeHandlerMessage()`, `isRpcResponseMessage()`, etc.

**Key Type Categories:**

#### Request/Response Types
```typescript
interface ZapRequest<TParams, TQuery> {
  request_id: string;      // Correlation ID
  method: string;
  path: string;
  path_only: string;
  query: TQuery;           // Parsed query params
  params: TParams;         // Route params
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}

interface ZapHandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Handler<TParams, TQuery, TResponse> =
  (request: ZapRequest<TParams, TQuery>) => TResponse | Promise<TResponse>;
```

#### Configuration Types
```typescript
interface SecurityConfig {
  headers?: SecurityHeadersConfig;
  rateLimit?: RateLimitConfig;
  cors?: CorsConfig;
}

interface CorsConfig {
  origins: string[];       // Required - no wildcard
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
}

interface RateLimitConfig {
  enabled?: boolean;
  max?: number;
  windowSecs?: number;
  storage?: 'memory' | 'redis';
  skipPaths?: string[];
}
```

#### Streaming & WebSocket Types
```typescript
type StreamingHandler<TParams, TQuery> =
  (request: ZapRequest<TParams, TQuery>) => AsyncIterable<StreamChunk>;

interface WsHandler {
  onConnect?: (connection: WsConnection) => void | Promise<void>;
  onMessage?: (connection: WsConnection, message: string | Uint8Array) => void | Promise<void>;
  onClose?: (connection: WsConnection, code?: number, reason?: string) => void | Promise<void>;
}
```

**User Benefits:**
- Full TypeScript autocomplete
- Type inference for handlers
- Compile-time error catching
- Self-documenting API

**Location:** `packages/client/src/runtime/types.ts`

---

## SERVER-SIDE APIs (`@zap-js/server`)

### 1. RPC (Remote Procedure Call)

**Purpose:** Call Rust server functions from TypeScript runtime.

**Access:**
```typescript
import {
  rpcCall, RpcError, initRpcClient,
  closeRpcClient, isRpcClientInitialized
} from '@zap-js/server'
```

**What It Offers:**
- **Initialization:** `initRpcClient(socketPath)`
- **Function Calls:** `rpcCall<T>(functionName, params, timeoutMs)`
- **Lifecycle:** `isRpcClientInitialized()`, `closeRpcClient()`
- **Error Class:** `RpcError` with error type

**API Surface:**

```typescript
// Initialize RPC client
initRpcClient(socketPath: string): void

// Make RPC calls
rpcCall<T>(
  functionName: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = 30000
): Promise<T>

// Lifecycle management
isRpcClientInitialized(): boolean
getRpcClient(): IpcClient | null
closeRpcClient(): Promise<void>

// Error handling
class RpcError extends Error {
  constructor(
    public readonly errorType: string,
    message: string
  )
}
```

**Key Features:**
- Type-safe generic responses `rpcCall<T>()`
- Configurable timeouts (default 30s)
- Automatic request ID tracking
- Pending request cleanup on errors
- Connection error propagation

**User Benefits:**
- Seamless TypeScript ↔ Rust communication
- Type safety across language boundary
- Automatic timeout handling
- Clean error handling with RpcError

**Example Usage:**
```typescript
import { rpcCall, initRpcClient } from '@zap-js/server';

// Initialize
initRpcClient('/tmp/zap.sock');

// Call Rust function
const result = await rpcCall<{ count: number }>(
  'getStats',
  { userId: '123' },
  5000 // timeout
);
```

**Location:** `packages/server/src/rpc.js`

---

### 2. IPC (Inter-Process Communication)

**Purpose:** Bidirectional communication between Rust and TypeScript over Unix sockets.

**Access:**
```typescript
import { IpcServer, IpcClient } from '@zap-js/server'
```

#### IPC Server (Rust → TypeScript)

**What It Offers:**
- **Initialization:** `new IpcServer(socketPath, encoding)`, `start()`, `stop()`
- **Handler Registration:** `registerHandler()`, `registerWsHandler()`
- **WebSocket Control:** `sendWsMessage()`, `closeWsConnection()`

**API Surface:**
```typescript
class IpcServer {
  constructor(socketPath: string, encoding: IpcEncoding = 'msgpack')
  async start(): Promise<void>
  async stop(): Promise<void>

  // Handler registration
  registerHandler(handlerId: string, handler: HandlerFunction): void
  registerWsHandler(handlerId: string, handler: WsHandlerFunction): void

  // WebSocket control
  sendWsMessage(connectionId: string, data: string, binary: boolean): void
  closeWsConnection(connectionId: string, code?: number, reason?: string): void
}
```

**Key Features:**
- MessagePack encoding (faster) with JSON fallback
- Length-prefixed framing (prevents corruption)
- 100MB message size limit
- Streaming response support
- WebSocket passthrough

**Example Usage:**
```typescript
import { IpcServer } from '@zap-js/server';

const ipcServer = new IpcServer('/tmp/zap.sock');

// Register HTTP handler
ipcServer.registerHandler('handler_0', async (req) => {
  console.log(`${req.method} ${req.path}`);
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ received: req.body })
  };
});

// Register WebSocket handler
ipcServer.registerWsHandler('ws_handler', {
  onConnect: async (conn) => {
    console.log('Client connected:', conn.id);
    conn.send('Welcome!');
  },
  onMessage: async (conn, message) => {
    console.log('Received:', message);
    conn.send(`Echo: ${message}`);
  },
  onClose: async (conn, code, reason) => {
    console.log('Client closed:', code, reason);
  }
});

await ipcServer.start();
```

#### IPC Client (TypeScript → Rust)

**What It Offers:**
- **Connection:** `new IpcClient(socketPath)`, `isConnected()`, `close()`
- **Messaging:** `send()`, `sendRecv()`
- **Events:** `connect`, `message`, `error`, `close`

**API Surface:**
```typescript
class IpcClient extends EventEmitter {
  constructor(socketPath: string, encoding: IpcEncoding = 'msgpack')
  isConnected(): boolean
  getEncoding(): IpcEncoding
  async close(): Promise<void>

  // Message sending
  send(message: IpcMessage): void
  async sendRecv(message: IpcMessage): Promise<IpcMessage>

  // Events
  on('connect', handler)     // Connection established
  on('message', handler)     // Message received
  on('error', handler)       // Connection/processing error
  on('close', handler)       // Connection closed
}
```

**Key Features:**
- Event-driven architecture
- Automatic encoding negotiation
- Promise-based request-response
- Connection state tracking

**User Benefits:**
- Non-blocking async/await API
- Reliable message delivery
- Support for HTTP, streaming, and WebSocket
- Full error propagation
- Type-safe message protocol

**Location:** `packages/server/src/ipc.js`

---

### 3. Types

**Purpose:** Type-safe server development with full TypeScript support.

**Access:**
```typescript
import type {
  ZapRequest, ZapHandlerResponse, Handler,
  StreamingHandler, WsHandler, WsConnection,
  ZapConfig, SecurityConfig, IpcMessage
} from '@zap-js/server'
```

**What It Offers:**

#### Request/Response Types
```typescript
// HTTP request from Rust
interface ZapRequest<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>
> {
  request_id: string;                     // Unique correlation ID
  method: string;                         // HTTP method
  path: string;                           // Full path with query
  path_only: string;                      // Path without query
  query: TQuery;                          // Parsed query parameters
  params: TParams;                        // Route parameters
  headers: Record<string, string>;        // HTTP headers
  body: string;                           // Request body
  cookies: Record<string, string>;        // Parsed cookies
}

// Response format for handlers
interface ZapHandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
```

#### Handler Types
```typescript
// Regular request handler
type Handler<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, string> = Record<string, string>,
  TResponse = unknown
> = (request: ZapRequest<TParams, TQuery>) => TResponse | Promise<TResponse>;

// Streaming handler (yields chunks over time)
type StreamingHandler<TParams, TQuery> = (
  request: ZapRequest<TParams, TQuery>
) => AsyncIterable<StreamChunk>;

// WebSocket handler
interface WsHandler {
  onConnect?: (connection: WsConnection) => void | Promise<void>;
  onMessage?: (connection: WsConnection, message: string | Uint8Array) => void | Promise<void>;
  onClose?: (connection: WsConnection, code?: number, reason?: string) => void | Promise<void>;
  onError?: (connection: WsConnection, error: Error) => void | Promise<void>;
}

// WebSocket connection interface
interface WsConnection {
  id: string;
  path: string;
  headers: Record<string, string>;
  send(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
```

#### Streaming Types
```typescript
interface StreamChunk {
  data?: string;                          // String data
  bytes?: Uint8Array;                     // Binary data
}

// Message types for streaming protocol
interface StreamStartMessage {
  type: 'stream_start';
  stream_id: string;
  status: number;
  headers: Record<string, string>;
}

interface StreamChunkMessage {
  type: 'stream_chunk';
  stream_id: string;
  data: string;                           // Base64-encoded
}

interface StreamEndMessage {
  type: 'stream_end';
  stream_id: string;
}
```

#### Configuration Types
```typescript
interface ZapConfig {
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
  security?: SecurityConfig;
  observability?: ObservabilityConfig;
}

interface RouteConfig {
  method: string;
  path: string;
  handler_id: string;
  is_typescript: boolean;
}
```

#### Security Types
```typescript
interface SecurityConfig {
  headers?: SecurityHeadersConfig;        // Security headers
  rateLimit?: RateLimitConfig;            // Rate limiting
  cors?: CorsConfig;                      // CORS policy
}

interface SecurityHeadersConfig {
  enabled?: boolean;
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  contentTypeOptions?: 'nosniff' | false;
  xssProtection?: string | false;
  hsts?: HstsConfig | false;
  contentSecurityPolicy?: string;
  referrerPolicy?: string;
}

interface CorsConfig {
  origins: string[];                      // Required - no wildcards
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

interface RateLimitConfig {
  enabled?: boolean;
  max?: number;                           // Requests per window
  windowSecs?: number;
  storage?: 'memory' | 'redis';
  redisUrl?: string;
  skipPaths?: string[];
  message?: string;
}
```

#### IPC Message Types
```typescript
// All message types (discriminated union)
type IpcMessage =
  | InvokeHandlerMessage         // Handler invocation
  | HandlerResponseMessage       // Handler response
  | ErrorMessage                 // Error response
  | HealthCheckMessage           // Health check
  | RpcCallMessage               // RPC call
  | RpcResponseMessage           // RPC response
  | RpcErrorMessage              // RPC error
  | StreamStartMessage           // Stream start
  | StreamChunkMessage           // Stream chunk
  | StreamEndMessage             // Stream end
  | WsConnectMessage             // WebSocket connect
  | WsMessageMessage             // WebSocket message
  | WsCloseMessage               // WebSocket close
  | WsSendMessage;               // WebSocket send

// RPC-specific types
interface RpcCallMessage {
  type: 'rpc_call';
  function_name: string;
  params: Record<string, unknown>;
  request_id: string;
}

interface RpcResponseMessage {
  type: 'rpc_response';
  request_id: string;
  result: unknown;
}

interface RpcErrorMessage {
  type: 'rpc_error';
  request_id: string;
  error: string;
  error_type: string;
}
```

#### Type Guards
```typescript
isInvokeHandlerMessage(msg: IpcMessage): msg is InvokeHandlerMessage
isHandlerResponseMessage(msg: IpcMessage): msg is HandlerResponseMessage
isErrorMessage(msg: IpcMessage): msg is ErrorMessage
isHealthCheckMessage(msg: IpcMessage): msg is HealthCheckMessage
isRpcResponseMessage(msg: RpcMessage): msg is RpcResponseMessage
isRpcErrorMessage(msg: RpcMessage): msg is RpcErrorMessage
isAsyncIterable<T>(value: unknown): value is AsyncIterable<T>
```

**User Benefits:**
- Full autocomplete in TypeScript handlers
- Type-safe IPC protocol
- Discriminated unions prevent message type errors
- Runtime type checking with guards
- Self-documenting configuration

**Location:** `packages/server/src/types.js` (JSDoc typed)

---

## API Summary Tables

### Client APIs

| API | Purpose | Key Exports | Import Path |
|-----|---------|-------------|-------------|
| **Router** | Client navigation | `RouterProvider`, `useRouter()`, `useParams()`, `Link` | `@zap-js/client` |
| **Middleware** | Route protection | `requireAuth()`, `requireRole()`, `preloadData()` | `@zap-js/client/router` |
| **Errors** | Error boundaries | `ErrorBoundary`, `useRouteError()`, `ZapError` | `@zap-js/client` |
| **Logger** | Structured logging | `logger.info()`, `logger.error()`, `logger.child()` | `@zap-js/client` |
| **WebSockets** | Real-time comms | `broadcast()`, `sendJson()`, `parseMessage()` | `@zap-js/client` |
| **Streaming** | Server streaming | `streamJson()`, `streamSSE()`, `mapStream()` | `@zap-js/client` |
| **Types** | Type safety | `Handler`, `ZapRequest`, `ZapConfig`, `IpcMessage` | `@zap-js/client` |

### Server APIs

| API | Purpose | Key Exports | Import Path |
|-----|---------|-------------|-------------|
| **RPC** | Call Rust functions | `rpcCall<T>()`, `initRpcClient()`, `RpcError` | `@zap-js/server` |
| **IPC** | Rust ↔ TypeScript comms | `IpcServer`, `IpcClient` | `@zap-js/server` |
| **Types** | Type-safe development | `ZapRequest`, `Handler`, `WsHandler`, guards | `@zap-js/server` |

---

## Architecture Principles

1. **Type Safety**: Full TypeScript support across the stack
2. **Observability**: Structured logging with correlation IDs
3. **Error Handling**: Unified error system with server correlation
4. **Performance**: Code splitting, prefetching, streaming support
5. **Developer Experience**: Composable APIs, middleware, type inference
6. **Production Ready**: Rate limiting, CORS, security headers, WebSocket support

---

## Related Documentation

- [Getting Started Guide](./getting-started.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [Usage Guide](./USAGE.md)
