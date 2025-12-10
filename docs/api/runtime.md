# @zapjs/runtime

The `@zapjs/runtime` package provides the core TypeScript wrapper for the Zap.js framework, including the main `Zap` class, process management, and IPC communication.

## Installation

```bash
npm install @zapjs/runtime
# or
bun add @zapjs/runtime
```

## Zap Class

The main class for configuring and running a Zap.js application.

### Basic Usage

```typescript
import { Zap } from '@zapjs/runtime';

const app = new Zap()
  .setPort(3000)
  .setHostname('127.0.0.1')
  .cors()
  .logging()
  .healthCheck('/health');

// Register routes
app.get('/', (req) => ({ message: 'Hello!' }));
app.post('/users', async (req) => {
  const body = JSON.parse(req.body);
  return { created: body };
});

// Start server
await app.listen();
```

### Configuration Methods

```typescript
class Zap {
  // Server settings
  setPort(port: number): this;
  setHostname(hostname: string): this;

  // Middleware
  cors(): this;
  logging(): this;
  compression(): this;

  // Endpoints
  healthCheck(path: string): this;
  metrics(path: string): this;

  // File-based routing
  useFileRouting(config?: FileRouteConfig): this;
}
```

### Route Registration

```typescript
class Zap {
  // HTTP methods
  get(path: string, handler: Handler): this;
  post(path: string, handler: Handler): this;
  put(path: string, handler: Handler): this;
  delete(path: string, handler: Handler): this;
  patch(path: string, handler: Handler): this;
  head(path: string, handler: Handler): this;

  // Static files
  static(prefix: string, directory: string): this;
}
```

### Lifecycle

```typescript
class Zap {
  // Start the server
  async listen(port?: number): Promise<void>;

  // Stop the server
  async close(): Promise<void>;

  // Check if running
  isRunning(): boolean;
}
```

### Handler Type

```typescript
type Handler = (request: ZapRequest) => Response | Promise<Response>;

interface ZapRequest {
  method: string;
  path: string;
  path_only: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}

type Response = object | string | { status?: number; headers?: Record<string, string>; body?: any };
```

## ProcessManager

Manages the Rust binary process lifecycle.

### Usage

```typescript
import { ProcessManager } from '@zapjs/runtime';

const manager = new ProcessManager();

// Start the Rust binary
await manager.start(config, 'info');

// Check status
if (manager.isRunning()) {
  console.log('Server running');
}

// Restart
await manager.restart(config, 'debug');

// Stop
await manager.stop();

// Get IPC socket path
const socketPath = manager.getSocketPath();
```

### API

```typescript
class ProcessManager {
  constructor();

  // Start the Rust binary with config
  async start(config: ZapConfig, logLevel: string): Promise<void>;

  // Stop the running process
  async stop(): Promise<void>;

  // Restart with new config
  async restart(config: ZapConfig, logLevel: string): Promise<void>;

  // Get IPC socket path
  getSocketPath(): string;

  // Check if process is running
  isRunning(): boolean;
}
```

## IPC Communication

### IpcServer

Listens for messages from the Rust binary and routes to handlers.

```typescript
import { IpcServer } from '@zapjs/runtime';

const server = new IpcServer(socketPath);

// Register handler
server.registerHandler('api_users_get', async (request) => {
  const user = await getUser(request.params.id);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  };
});

// Start listening
await server.start();

// Stop
await server.stop();
```

### IpcClient

Connects to the Rust IPC server for RPC calls.

```typescript
import { IpcClient } from '@zapjs/runtime';

const client = new IpcClient();
await client.connect(socketPath);

// Send message
await client.send({
  type: 'invoke_handler',
  handler_id: 'my_handler',
  request: { method: 'GET', path: '/', ... },
});

// Receive response
const response = await client.receive();
```

### Message Types

```typescript
interface IpcMessage {
  type: 'invoke_handler' | 'handler_response' | 'health_check' | 'health_check_response' | 'error';
  handler_id?: string;
  request?: IpcRequest;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  code?: string;
  message?: string;
}

interface IpcRequest {
  method: string;
  path: string;
  path_only: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}
```

## RPC Client

For calling Rust functions from TypeScript.

```typescript
import { initRpcClient, rpcCall, closeRpcClient } from '@zapjs/runtime';

// Initialize
initRpcClient('/tmp/zap.sock');

// Make RPC call
const result = await rpcCall<User>('users.get', { id: 123 });

// With timeout
const result = await rpcCall<User>('users.get', { id: 123 }, 5000);

// Close connection
await closeRpcClient();
```

### API

```typescript
// Initialize the RPC client
function initRpcClient(socketPath: string): void;

// Call a Rust function
async function rpcCall<T = any>(
  functionName: string,
  params?: Record<string, any>,
  timeoutMs?: number
): Promise<T>;

// Close the client
async function closeRpcClient(): Promise<void>;

// Check if initialized
function isRpcClientInitialized(): boolean;

// Get client instance
function getRpcClient(): IpcClient | null;
```

### RpcError

```typescript
class RpcError extends Error {
  readonly errorType: string;

  constructor(errorType: string, message: string);
}
```

## Configuration Types

### ZapConfig

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
}
```

### RouteConfig

```typescript
interface RouteConfig {
  method: string;
  path: string;
  handler_id: string;
  is_typescript: boolean;
}
```

### MiddlewareConfig

```typescript
interface MiddlewareConfig {
  enable_cors?: boolean;
  enable_logging?: boolean;
  enable_compression?: boolean;
}
```

### FileRouteConfig

```typescript
interface FileRouteConfig {
  routesDir?: string;      // Default: './routes'
  generatedDir?: string;   // Default: './src/generated'
  watch?: boolean;         // Default: true in dev
}
```

## Complete Example

```typescript
// src/server.ts
import { Zap } from '@zapjs/runtime';

const app = new Zap()
  .setPort(3000)
  .setHostname('0.0.0.0')
  .cors()
  .logging()
  .healthCheck('/health')
  .useFileRouting({
    routesDir: './routes',
    generatedDir: './src/generated',
  });

// Custom routes alongside file-based routes
app.get('/custom', () => ({ custom: true }));

// Static files
app.static('/assets', './public/assets');

// Start
app.listen().then(() => {
  console.log('Server running on http://localhost:3000');
});
```

---

## See Also

- [Router API](./router.md) - File-based routing
- [CLI Reference](./cli.md) - Command-line tools
- [Architecture](../ARCHITECTURE.md) - System design
