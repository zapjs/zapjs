# ZapJS Architecture

This document provides a comprehensive technical overview of how ZapJS works internally - from the Rust server to TypeScript handlers, type generation, and everything in between.

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Data Flow](#data-flow)
3. [The IPC System](#the-ipc-system)
4. [Codegen System](#codegen-system)
5. [Type Generation](#type-generation)
6. [File-Based Routing](#file-based-routing)
7. [Streaming Responses](#streaming-responses)
8. [WebSocket Handlers](#websocket-handlers)
9. [Static Site Generation (SSG)](#static-site-generation-ssg)
10. [Performance Optimizations](#performance-optimizations)

---

## High-Level Overview

ZapJS is a fullstack framework that combines:

- **Rust Server**: Handles HTTP, routing, static files (10-100x faster than Node.js)
- **TypeScript Handlers**: Business logic in a familiar language
- **IPC Bridge**: Sub-millisecond communication via Unix domain sockets
- **Bidirectional Types**: Rust types automatically become TypeScript interfaces

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTP/WebSocket
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Rust Server (Hyper)                        │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ HTTP Parser │  │ Router (9ns) │  │ Static File Server     │ │
│  │   (SIMD)    │  │   (AHash)    │  │                        │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Unix Domain Socket (MessagePack)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   TypeScript IPC Server                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Route Handlers (api/*.ts)                   │   │
│  │  export const GET = async (req) => { ... }              │   │
│  │  export const POST = async (req) => { ... }             │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           RPC Client (calls Rust #[export] functions)    │   │
│  │  await rpcCall('get_user', { id: '123' })               │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Request Lifecycle (HTTP)

```
1. Browser sends HTTP request
        ↓
2. Rust Server receives request
   - Hyper parses HTTP (SIMD-optimized)
   - Router matches route (9ns with AHash)
        ↓
3. IPC to TypeScript
   - Rust connects to Unix socket
   - Sends InvokeHandler message (MessagePack)
        ↓
4. TypeScript Handler executes
   - Route handler runs (e.g., routes/api/hello.ts)
   - May call Rust backend via rpcCall()
        ↓
5. Response flows back
   - Handler returns { status, headers, body }
   - IPC sends HandlerResponse message
        ↓
6. Rust sends HTTP response
   - Client receives JSON/HTML/etc.
```

### Calling Rust Functions from TypeScript

When TypeScript needs to call a Rust `#[export]` function:

```typescript
// TypeScript handler
import { rpcCall } from './generated/rpc-client';

export const GET = async () => {
  // This calls the Rust get_user function
  const user = await rpcCall<User>('get_user', { id: '123' });
  return user;
};
```

The RPC call goes to `/__zap_rpc` endpoint:

```
TypeScript Handler
    ↓ rpcCall('get_user', { id: '123' })
HTTP POST to /__zap_rpc
    ↓
Rust RPC Handler
    ↓ Deserializes params
    ↓ Calls #[export] fn get_user(id: String)
    ↓ Serializes result
Response back to TypeScript
```

---

## The IPC System

ZapJS uses Unix domain sockets for inter-process communication between Rust and TypeScript. This provides:

- **Zero network overhead** (no TCP/IP stack)
- **Sub-millisecond latency**
- **High throughput** (100K+ messages/second)

### Message Format

All IPC messages use a length-prefixed frame format:

```
┌──────────────────┬─────────────────────────────┐
│ 4 bytes (BE u32) │ Payload (MessagePack/JSON)  │
│   Length prefix  │                             │
└──────────────────┴─────────────────────────────┘
```

- **MessagePack** is preferred (40% smaller than JSON)
- **Auto-detection**: JSON starts with `{` (0x7B), MessagePack with 0x80-0xBF
- **100MB max** message size for security

### Message Types

```rust
enum IpcMessage {
    // HTTP Handler Invocation
    InvokeHandler { handler_id, request },
    HandlerResponse { handler_id, status, headers, body },
    HandlerError { handler_id, error },

    // Health Checks
    HealthCheck,
    HealthCheckResponse { status },

    // Streaming
    StreamStart { stream_id, status, headers },
    StreamChunk { stream_id, data },
    StreamEnd { stream_id },

    // WebSocket
    WsConnect { connection_id, handler_id, path, headers },
    WsMessage { connection_id, data },
    WsClose { connection_id, code, reason },
    WsSend { connection_id, data },
    WsSendBinary { connection_id, data },
}
```

### IPC Request Structure

When Rust invokes a TypeScript handler:

```typescript
interface IpcRequest {
  request_id: string;          // Unique ID for correlation
  method: string;              // GET, POST, PUT, DELETE
  path: string;                // Full path with query string
  path_only: string;           // Path without query
  query: Record<string, string>;
  params: Record<string, string>;  // URL params (:id)
  headers: Record<string, string>;
  body: string;                // UTF-8 encoded body
  cookies: Record<string, string>;
}
```

---

## Codegen System

ZapJS has two codegen systems:

### 1. Rust Codegen (`packages/codegen/`)

Scans Rust source files for `#[export]` functions and `#[derive(Serialize)]` structs.

**Input (Rust):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[export]
pub async fn get_user(id: String) -> Result<User, ApiError> {
    // ...
}
```

**Output Files:**

1. **`types.ts`** - TypeScript interfaces:
```typescript
export interface User {
  id: string;
  name: string;
  createdAt: string;  // Respects serde rename
}

export interface ApiError {
  code: string;
  message: string;
}
```

2. **`backend.ts`** - Runtime bindings:
```typescript
import { rpcCall } from './rpc-client';
import type { User, ApiError } from './types';

export const backend = {
  async getUser(id: string): Promise<User | ApiError> {
    return rpcCall<User | ApiError>('get_user', { id });
  },
};
```

3. **`backend.d.ts`** - Type definitions:
```typescript
export interface ZapBackend {
  getUser(id: string): Promise<User | ApiError>;
}
export declare const backend: ZapBackend;
```

**Type Mapping:**

| Rust Type | TypeScript Type |
|-----------|-----------------|
| `String`, `&str` | `string` |
| `i32`, `u64`, `f64`, etc. | `number` |
| `bool` | `boolean` |
| `Option<T>` | `T \| null` |
| `Vec<T>` | `T[]` |
| `HashMap<K, V>` | `Record<K, V>` |
| `Result<T, E>` | `T \| E` (union type) |
| Custom struct | Same name (interface) |

### 2. Router Codegen (`packages/router/src/codegen.ts`)

Scans the `/routes` directory and generates routing configuration.

**Output Files:**

1. **`routeTree.ts`** - React route components:
```typescript
import { lazy } from 'react';

const BlogSlugRoute = lazy(() => import('../../routes/blog/[slug]'));
const BlogSlugErrorComponent = lazy(() =>
  import('../../routes/blog/[slug]').then(m => ({ default: m.errorComponent }))
);

export const routes = [
  {
    path: '/blog/:slug',
    component: BlogSlugRoute,
    errorComponent: BlogSlugErrorComponent,
    params: [{ name: 'slug', optional: false, catchAll: false }],
    priority: 2500,
  },
];
```

2. **`routeManifest.json`** - For Rust server:
```json
{
  "routes": [
    { "path": "/blog/:slug", "filePath": "blog/[slug].tsx" }
  ],
  "apiRoutes": [
    { "path": "/api/users/:id", "filePath": "api/users.$id.ts", "params": ["id"] }
  ]
}
```

3. **`routerConfig.ts`** - Compiled route patterns with regex

---

## Type Generation

Types flow bidirectionally between Rust and TypeScript:

```
┌─────────────────────────────────────────────────────────────┐
│                     Rust Source Code                        │
│                                                             │
│  #[derive(Serialize)]          #[export]                   │
│  pub struct User { ... }       pub fn get_user() -> User   │
└─────────────────────────────────────┬───────────────────────┘
                                      │
                        zap-codegen scans (syn crate)
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  Generated TypeScript                       │
│                                                             │
│  // types.ts                   // backend.ts                │
│  interface User { ... }        backend.getUser(): User      │
└─────────────────────────────────────────────────────────────┘
                                      │
                        TypeScript handlers import
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   API Route Handlers                        │
│                                                             │
│  import { backend, User } from './generated/backend';       │
│  const user: User = await backend.getUser('123');           │
└─────────────────────────────────────────────────────────────┘
```

### serde Attribute Support

The codegen respects serde attributes:

```rust
#[derive(Serialize)]
pub struct Post {
    pub id: String,

    #[serde(rename = "createdAt")]
    pub created_at: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}
```

Generates:
```typescript
interface Post {
  id: string;
  createdAt: string;      // Renamed
  deletedAt?: string;     // Optional
}
```

---

## File-Based Routing

ZapJS uses Next.js-style file-based routing in the `/routes` directory.

### Route Conventions

| File Path | URL Path | Description |
|-----------|----------|-------------|
| `routes/index.tsx` | `/` | Index route |
| `routes/about.tsx` | `/about` | Static route |
| `routes/blog/[id].tsx` | `/blog/:id` | Dynamic param |
| `routes/blog/[...slug].tsx` | `/blog/*slug` | Catch-all |
| `routes/blog/[[...slug]].tsx` | `/blog/*slug?` | Optional catch-all |
| `routes/posts.$id.tsx` | `/posts/:id` | Dot-separated param |
| `routes/api/users.ts` | `/api/users` | API route |
| `routes/_layout.tsx` | - | Layout (wraps children) |
| `routes/(group)/about.tsx` | `/about` | Route group (no URL segment) |

### API Routes

Export HTTP method handlers:

```typescript
// routes/api/users.ts
import type { ZapRequest } from '@zapjs/runtime';

export const GET = async (req: ZapRequest) => {
  const users = await backend.listUsers(10, 0);
  return users;
};

export const POST = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.createUser(body.name, body.email, body.role);
};
```

### Dynamic Params

```typescript
// routes/api/users.$id.ts
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;  // From URL
  return backend.getUser(id);
};
```

### Special Exports

Routes can export special components/functions:

```typescript
// routes/blog/[slug].tsx

// Main component (required)
export default function BlogPost({ params }) { ... }

// Error boundary (optional)
export function errorComponent({ error, reset }) { ... }

// Loading state (optional)
export function pendingComponent() { ... }

// Meta/head tags (optional)
export function meta({ params }) {
  return { title: `Post: ${params.slug}` };
}

// Route middleware (optional)
export const middleware = [authMiddleware, logMiddleware];

// SSG params (optional)
export async function generateStaticParams() {
  return [{ slug: 'post-1' }, { slug: 'post-2' }];
}
```

### Route Priority

Routes are matched by specificity (higher = matched first):

```
Priority Calculation:
- Base: 1000 points per segment
- Static segment: +500 points
- Dynamic segment: +100 points
- Optional dynamic: +50 points
- Catch-all: 0 points
- Optional catch-all: -100 points

Examples:
/users/profile     → 3000 (2 static segments)
/users/:id         → 2600 (1 static + 1 dynamic)
/users/:id/posts   → 3600 (2 static + 1 dynamic)
/blog/*slug        → 1000 (1 static + catch-all)
```

---

## Streaming Responses

For large responses or server-sent events, use async generators:

```typescript
// routes/api/stream.ts
export const GET = async function* () {
  // Send initial event
  yield { data: 'event: start\ndata: {"status":"starting"}\n\n' };

  // Stream progress
  for (let i = 1; i <= 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    yield { data: `event: progress\ndata: {"step":${i}}\n\n` };
  }

  // Complete
  yield { data: 'event: complete\ndata: {"status":"done"}\n\n' };
};
```

### IPC Flow for Streaming

```
TypeScript Generator
    ↓ yield { data: '...' }
StreamChunk IPC message
    ↓
Rust receives chunk
    ↓
HTTP chunked transfer encoding
    ↓
Browser receives chunk
```

Message sequence:
1. `StreamStart` - Opens response with status/headers
2. `StreamChunk` - Each yielded chunk (base64 for binary)
3. `StreamEnd` - Closes the stream

---

## WebSocket Handlers

Export a `WEBSOCKET` handler for WebSocket routes:

```typescript
// routes/api/ws-echo.ts
import type { WsConnection, WsHandler } from '@zapjs/runtime';

const clients = new Map<string, WsConnection>();

export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    clients.set(connection.id, connection);
    connection.send(JSON.stringify({
      type: 'connected',
      id: connection.id
    }));
  },

  onMessage: async (connection, message) => {
    // message is string or Uint8Array
    const text = typeof message === 'string'
      ? message
      : new TextDecoder().decode(message);

    // Echo back
    connection.send(JSON.stringify({
      type: 'echo',
      message: text
    }));
  },

  onClose: async (connection, code, reason) => {
    clients.delete(connection.id);
  },

  onError: async (connection, error) => {
    console.error(`WS Error: ${error.message}`);
  }
};
```

### WsConnection API

```typescript
interface WsConnection {
  id: string;                    // Unique connection ID
  path: string;                  // Request path
  headers: Record<string, string>;

  send(data: string): void;           // Send text
  sendBinary(data: Uint8Array): void; // Send binary
  close(code?: number, reason?: string): void;
}
```

### IPC Flow for WebSocket

```
Browser → WS Connect → Rust Server
                         ↓ WsConnect message
                      TypeScript
                         ↓ onConnect()

Browser → WS Message → Rust Server
                         ↓ WsMessage message
                      TypeScript
                         ↓ onMessage()
                         ↓ connection.send()
                         ↓ WsSend message
                      Rust Server → WS Message → Browser
```

---

## Static Site Generation (SSG)

Routes can export `generateStaticParams` for build-time pre-rendering:

```typescript
// routes/blog/[slug].tsx

// Called at build time
export async function generateStaticParams() {
  const posts = await rpcCall<ListPostsResponse>('list_posts', {
    page: 1, limit: 100, tag: null, author: null
  });

  return posts.posts.map(post => ({
    slug: post.slug
  }));
}

// Rendered for each param set
export default function BlogPost({ params }: { params: { slug: string } }) {
  // ...
}
```

### Build Process

1. **Scan** routes for `generateStaticParams` export
2. **Call** function to get params array
3. **Build** concrete paths: `/blog/hello-world`, `/blog/intro`
4. **Pre-render** each path to static HTML
5. **Output** to `dist/blog/hello-world/index.html`

### SSG Manifest

Generated `ssg-manifest.json`:

```json
{
  "routes": [
    {
      "pattern": "/blog/:slug",
      "path": "/blog/hello-world",
      "params": { "slug": "hello-world" },
      "outputPath": "dist/blog/hello-world/index.html"
    }
  ]
}
```

At runtime, Rust checks this manifest for static file matches.

---

## Performance Optimizations

### Rust Server

| Optimization | Benefit |
|--------------|---------|
| SIMD HTTP parsing (simdutf8) | 2-5x faster header parsing |
| AHash routing | 9ns route lookup |
| MessagePack IPC | 40% smaller than JSON |
| Unix domain socket | No TCP overhead |
| Connection pooling | Reuse IPC connections |
| Zero-allocation routing | No GC pressure |

### TypeScript Runtime

| Optimization | Benefit |
|--------------|---------|
| Lazy component loading | Smaller initial bundle |
| Async route handlers | Non-blocking I/O |
| Streaming responses | Memory efficient |
| WebSocket for realtime | No polling overhead |

### Benchmarks (Approximate)

```
Operation                    Time
─────────────────────────────────
Route lookup (Rust)          9ns
IPC round-trip              <1ms
Simple handler             2-5ms
Database query handler    10-50ms
Static file serve          <1ms
```

---

## Directory Structure

A typical ZapJS project:

```
my-app/
├── routes/                 # File-based routing
│   ├── index.tsx          # Home page (/)
│   ├── about.tsx          # /about
│   ├── blog/
│   │   ├── index.tsx      # /blog
│   │   └── [slug].tsx     # /blog/:slug
│   ├── api/
│   │   ├── users.ts       # /api/users
│   │   └── users.$id.ts   # /api/users/:id
│   └── _layout.tsx        # Root layout
├── src/
│   ├── api/               # Rust codegen output
│   │   ├── types.ts       # Generated types
│   │   ├── backend.ts     # Generated RPC client
│   │   └── rpc-client.ts  # RPC implementation
│   ├── generated/         # Router codegen output
│   │   ├── routeTree.ts   # Route components
│   │   └── routeManifest.json
│   └── components/        # React components
├── server/
│   └── src/
│       └── main.rs        # Rust backend (#[export] functions)
├── package.json
└── zap.config.ts          # ZapJS configuration
```

---

## Summary

ZapJS achieves its performance and developer experience through:

1. **Division of labor**: Rust handles the fast path (HTTP, routing), TypeScript handles flexibility (business logic)
2. **Zero-overhead IPC**: Unix sockets with MessagePack serialization
3. **Type safety**: Rust types automatically become TypeScript interfaces
4. **Convention over configuration**: File-based routing, automatic codegen
5. **Modern features**: SSG, streaming, WebSocket support built-in

The architecture is designed so you write TypeScript like a normal fullstack app, but get Rust-level performance where it matters most.
