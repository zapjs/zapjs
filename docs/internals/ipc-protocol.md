# IPC Protocol

This document details the Inter-Process Communication protocol between the Rust HTTP server and TypeScript handlers.

## Overview

Zap.js uses Unix Domain Sockets with newline-delimited JSON (NDJSON) for communication between:
- **Rust Server**: Handles HTTP requests, routing, static files
- **TypeScript Process**: Executes handler functions, business logic

```
┌─────────────────┐                    ┌─────────────────┐
│   Rust Server   │◄──────────────────►│   TypeScript    │
│   (HTTP :3000)  │   Unix Socket IPC  │   (Handlers)    │
└─────────────────┘                    └─────────────────┘
```

## Transport Layer

### Unix Domain Socket

- **Path**: `/tmp/zap-{pid}.sock` (configurable)
- **Type**: Stream socket (SOCK_STREAM)
- **Framing**: Newline-delimited (`\n`)
- **Encoding**: UTF-8 JSON

### Why Unix Sockets?

| Feature | Unix Socket | TCP |
|---------|-------------|-----|
| Latency | ~10μs | ~100μs |
| Security | File permissions | Network exposed |
| Setup | No port conflicts | Port management |
| Cleanup | Auto on process exit | Manual |

## Message Format

All messages are JSON objects terminated by newline:

```json
{"type":"message_type","field":"value"}\n
```

## Message Types

### 1. invoke_handler

**Direction**: Rust → TypeScript

Requests execution of a TypeScript handler.

```json
{
  "type": "invoke_handler",
  "handler_id": "api_users_$id_get",
  "request": {
    "method": "GET",
    "path": "/api/users/123?include=posts",
    "path_only": "/api/users/123",
    "query": {
      "include": "posts"
    },
    "params": {
      "id": "123"
    },
    "headers": {
      "Host": "localhost:3000",
      "Accept": "application/json",
      "Authorization": "Bearer token123"
    },
    "body": "",
    "cookies": {
      "session": "abc123"
    }
  }
}
```

### 2. handler_response

**Direction**: TypeScript → Rust

Returns the handler result.

```json
{
  "type": "handler_response",
  "handler_id": "api_users_$id_get",
  "status": 200,
  "headers": {
    "Content-Type": "application/json",
    "X-Request-Id": "req_abc123"
  },
  "body": "{\"id\":123,\"name\":\"John\",\"email\":\"john@example.com\"}"
}
```

### 3. health_check

**Direction**: Rust → TypeScript

Verifies TypeScript process is alive.

```json
{
  "type": "health_check"
}
```

### 4. health_check_response

**Direction**: TypeScript → Rust

Confirms health check.

```json
{
  "type": "health_check_response"
}
```

### 5. error

**Direction**: Either

Reports an error condition.

```json
{
  "type": "error",
  "code": "HANDLER_NOT_FOUND",
  "message": "No handler registered for api_users_$id_get"
}
```

#### Error Codes

| Code | Description |
|------|-------------|
| `HANDLER_NOT_FOUND` | No handler for handler_id |
| `HANDLER_ERROR` | Handler threw exception |
| `PARSE_ERROR` | Invalid JSON message |
| `TIMEOUT` | Handler execution timeout |
| `INTERNAL_ERROR` | Unexpected error |

## Request Flow

### Successful Request

```
Client              Rust Server           TypeScript
  │                     │                     │
  │─── HTTP GET ───────►│                     │
  │                     │                     │
  │                     │── invoke_handler ──►│
  │                     │                     │
  │                     │                     │──── Execute
  │                     │                     │     Handler
  │                     │                     │
  │                     │◄─ handler_response ─│
  │                     │                     │
  │◄── HTTP 200 ────────│                     │
  │                     │                     │
```

### Error Handling

```
Client              Rust Server           TypeScript
  │                     │                     │
  │─── HTTP GET ───────►│                     │
  │                     │                     │
  │                     │── invoke_handler ──►│
  │                     │                     │
  │                     │                     │──── Handler
  │                     │                     │     Throws
  │                     │                     │
  │                     │◄───── error ────────│
  │                     │                     │
  │◄── HTTP 500 ────────│                     │
  │                     │                     │
```

### Timeout

```
Client              Rust Server           TypeScript
  │                     │                     │
  │─── HTTP GET ───────►│                     │
  │                     │                     │
  │                     │── invoke_handler ──►│
  │                     │                     │
  │                     │      30s timeout    │──── Slow
  │                     │                     │     Handler
  │                     │                     │
  │◄── HTTP 504 ────────│                     │
  │                     │                     │
```

## IpcRequest Structure

```typescript
interface IpcRequest {
  // HTTP method
  method: string;  // "GET", "POST", "PUT", "DELETE", etc.

  // Full path including query string
  path: string;  // "/api/users/123?include=posts"

  // Path without query string
  path_only: string;  // "/api/users/123"

  // Parsed query parameters
  query: Record<string, string>;  // { "include": "posts" }

  // Route parameters (from path)
  params: Record<string, string>;  // { "id": "123" }

  // HTTP headers (lowercase keys)
  headers: Record<string, string>;

  // Request body (raw string)
  body: string;

  // Parsed cookies
  cookies: Record<string, string>;
}
```

## Handler ID Convention

Handler IDs are derived from file paths and HTTP methods:

| File Path | Method | Handler ID |
|-----------|--------|------------|
| `routes/api/hello.ts` | GET | `api_hello_get` |
| `routes/api/users.ts` | POST | `api_users_post` |
| `routes/api/users.$id.ts` | GET | `api_users_$id_get` |
| `routes/api/users.$id.ts` | DELETE | `api_users_$id_delete` |

### Generation Rule

```
handler_id = path.replace('routes/', '')
                 .replace(/\//g, '_')
                 .replace(/\./g, '_')
                 .replace('.ts', '')
             + '_' + method.toLowerCase()
```

## Rust Implementation

### IpcClient (Rust side)

```rust
pub struct IpcClient {
    stream: UnixStream,
}

impl IpcClient {
    pub async fn connect(socket_path: &str) -> Result<Self, ZapError> {
        let stream = UnixStream::connect(socket_path).await?;
        Ok(Self { stream })
    }

    pub async fn send_message(&mut self, msg: &IpcMessage) -> Result<(), ZapError> {
        let json = serde_json::to_string(msg)?;
        self.stream.write_all(json.as_bytes()).await?;
        self.stream.write_all(b"\n").await?;
        Ok(())
    }

    pub async fn recv_message(&mut self) -> Result<IpcMessage, ZapError> {
        let mut reader = BufReader::new(&mut self.stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let msg = serde_json::from_str(&line)?;
        Ok(msg)
    }
}
```

### Proxy Handler

```rust
pub struct ProxyHandler {
    handler_id: String,
    ipc_socket_path: Arc<String>,
    timeout_secs: u64,
}

impl Handler for ProxyHandler {
    async fn handle(&self, req: RequestData) -> Result<ZapResponse, ZapError> {
        // Connect to TypeScript
        let mut client = IpcClient::connect(&self.ipc_socket_path).await?;

        // Build IPC request
        let ipc_request = IpcRequest::from_request_data(&req);

        // Send invoke message
        client.send_message(&IpcMessage::InvokeHandler {
            handler_id: self.handler_id.clone(),
            request: ipc_request,
        }).await?;

        // Wait for response with timeout
        let response = tokio::time::timeout(
            Duration::from_secs(self.timeout_secs),
            client.recv_message()
        ).await??;

        // Convert to HTTP response
        match response {
            IpcMessage::HandlerResponse { status, headers, body, .. } => {
                Ok(ZapResponse::Custom(
                    Response::new()
                        .status(StatusCode::new(status))
                        .headers(headers)
                        .body(body)
                ))
            }
            IpcMessage::Error { code, message } => {
                Err(ZapError::Handler(format!("{}: {}", code, message)))
            }
            _ => Err(ZapError::Internal("Unexpected response".into()))
        }
    }
}
```

## TypeScript Implementation

### IpcServer

```typescript
class IpcServer {
  private server: net.Server;
  private handlers: Map<string, HandlerFunction> = new Map();

  constructor(private socketPath: string) {}

  registerHandler(handlerId: string, handler: HandlerFunction) {
    this.handlers.set(handlerId, handler);
  }

  async start() {
    // Remove existing socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      const reader = readline.createInterface({ input: socket });

      reader.on('line', async (line) => {
        try {
          const message = JSON.parse(line);
          const response = await this.handleMessage(message);
          socket.write(JSON.stringify(response) + '\n');
        } catch (error) {
          socket.write(JSON.stringify({
            type: 'error',
            code: 'PARSE_ERROR',
            message: error.message,
          }) + '\n');
        }
      });
    });

    this.server.listen(this.socketPath);
  }

  private async handleMessage(msg: IpcMessage): Promise<IpcMessage> {
    switch (msg.type) {
      case 'invoke_handler':
        return this.invokeHandler(msg.handler_id, msg.request);

      case 'health_check':
        return { type: 'health_check_response' };

      default:
        return {
          type: 'error',
          code: 'UNKNOWN_MESSAGE',
          message: `Unknown message type: ${msg.type}`,
        };
    }
  }

  private async invokeHandler(
    handlerId: string,
    request: IpcRequest
  ): Promise<IpcMessage> {
    const handler = this.handlers.get(handlerId);

    if (!handler) {
      return {
        type: 'error',
        code: 'HANDLER_NOT_FOUND',
        message: `No handler for ${handlerId}`,
      };
    }

    try {
      const result = await handler(request);

      // Normalize response
      let status = 200;
      let headers: Record<string, string> = {};
      let body: string;

      if (typeof result === 'string') {
        body = result;
        headers['Content-Type'] = 'text/plain';
      } else if (result.status !== undefined) {
        status = result.status;
        headers = result.headers || {};
        body = typeof result.body === 'string'
          ? result.body
          : JSON.stringify(result.body);
      } else {
        body = JSON.stringify(result);
        headers['Content-Type'] = 'application/json';
      }

      return {
        type: 'handler_response',
        handler_id: handlerId,
        status,
        headers,
        body,
      };
    } catch (error) {
      return {
        type: 'error',
        code: 'HANDLER_ERROR',
        message: error.message,
      };
    }
  }
}
```

## Performance Considerations

### Latency Breakdown

| Operation | Time |
|-----------|------|
| Socket connect | ~5μs |
| JSON serialize | ~10μs |
| Socket write | ~5μs |
| Handler execution | varies |
| JSON deserialize | ~10μs |
| Socket read | ~5μs |
| **Total overhead** | **~35μs** |

### Optimizations

1. **Connection pooling**: Reuse socket connections
2. **Buffer reuse**: Pre-allocate buffers for serialization
3. **Async I/O**: Non-blocking socket operations
4. **Keep-alive**: Maintain persistent connections

### Benchmarks

```
IPC round-trip (empty handler): ~100μs
IPC round-trip (JSON response):  ~150μs
IPC round-trip (complex query):  ~200μs
```

---

## See Also

- [Architecture](../ARCHITECTURE.md) - System design
- [zap-server](../rust/zap-server.md) - Server implementation
- [Performance](./performance.md) - Optimization details
