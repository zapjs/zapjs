# Zap.js Architecture

This document provides a comprehensive technical overview of the Zap.js framework architecture, covering system design, component relationships, data flows, and key design decisions.

## Table of Contents

- [System Overview](#system-overview)
- [Component Architecture](#component-architecture)
- [Crate Dependencies](#crate-dependencies)
- [Request Lifecycle](#request-lifecycle)
- [IPC Protocol](#ipc-protocol)
- [Build Pipeline](#build-pipeline)
- [File-Based Routing](#file-based-routing)
- [Code Generation](#code-generation)
- [Performance Characteristics](#performance-characteristics)
- [Design Decisions](#design-decisions)

---

## System Overview

Zap.js is a fullstack web framework that combines **React** (frontend) with **Rust** (backend), where the Rust backend compiles into a high-performance binary that communicates with TypeScript handlers via IPC.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Zap.js Framework                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │      TypeScript Layer       │    │          Rust Layer                 │ │
│  ├─────────────────────────────┤    ├─────────────────────────────────────┤ │
│  │                             │    │                                     │ │
│  │  @zapjs/runtime             │◄──►│  zap-server (HTTP Server)           │ │
│  │  - Zap class                │IPC │  - Hyper/Tokio async runtime        │ │
│  │  - ProcessManager           │    │  - Radix router (9ns lookups)       │ │
│  │  - IpcServer/Client         │    │  - Middleware chain                 │ │
│  │                             │    │  - Static file serving              │ │
│  │  @zapjs/router              │    │                                     │ │
│  │  - File-based routing       │    │  zap-core (Primitives)              │ │
│  │  - TanStack conventions     │    │  - Zero-copy HTTP parsing           │ │
│  │  - Route tree generation    │    │  - Method/Params/Headers            │ │
│  │                             │    │  - Request/Response types           │ │
│  │  @zapjs/dev-server          │    │                                     │ │
│  │  - Hot reload orchestration │    │  zap-macros                         │ │
│  │  - Rust builder             │    │  - #[zap::export] proc macro        │ │
│  │  - Vite proxy               │    │  - Type metadata extraction         │ │
│  │                             │    │                                     │ │
│  │  @zapjs/cli                 │    │  zap-codegen                        │ │
│  │  - zap dev/build/serve      │    │  - TypeScript binding generator     │ │
│  │                             │    │  - Namespaced server client         │ │
│  │                             │    │                                     │ │
│  └─────────────────────────────┘    └─────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Single Binary Deployment**: The Rust backend compiles to a standalone binary
2. **Zero-Copy Performance**: HTTP parsing and routing use borrowed references
3. **Type-Safe RPC**: Rust functions are automatically exposed with TypeScript types
4. **File-Based Routing**: TanStack-style conventions for automatic route discovery
5. **Hot Reload**: Full-stack hot reload in development mode

---

## Component Architecture

### TypeScript Packages

| Package | Purpose |
|---------|---------|
| `@zapjs/runtime` | Core wrapper: Zap class, process management, IPC communication |
| `@zapjs/router` | File-based routing scanner, route tree generation |
| `@zapjs/cli` | CLI commands: `dev`, `build`, `serve`, `codegen`, `routes` |
| `@zapjs/dev-server` | Development orchestration: Rust builder, Vite proxy, hot reload |
| `create-zap-app` | Project scaffolding tool |

### Rust Crates

| Crate | Purpose |
|-------|---------|
| `zap-core` | HTTP primitives: Router, HttpParser, Request/Response, Middleware |
| `zap-server` | HTTP server: Zap struct, handlers, IPC proxy, static files |
| `zap-macros` | Procedural macro: `#[zap::export]` for function export |
| `zap-codegen` | Code generator: TypeScript bindings from Rust metadata |

---

## Crate Dependencies

```
                    ┌─────────────────┐
                    │   zap-codegen   │
                    │  (TS generator) │
                    └────────┬────────┘
                             │ reads metadata from
                             ▼
                    ┌─────────────────┐
                    │   zap-macros    │
                    │ (#[zap::export])│
                    └────────┬────────┘
                             │ used by
                             ▼
                    ┌─────────────────┐
                    │   zap-server    │
                    │  (HTTP server)  │
                    └────────┬────────┘
                             │ depends on
                             ▼
                    ┌─────────────────┐
                    │    zap-core     │
                    │  (primitives)   │
                    └─────────────────┘
```

### External Dependencies

**Rust:**
- `tokio` - Async runtime
- `hyper` - HTTP implementation
- `serde`/`serde_json` - Serialization
- `ahash` - Fast hashing
- `memchr` - SIMD string scanning
- `syn`/`quote`/`proc-macro2` - Macro utilities

**TypeScript:**
- `chokidar` - File watching
- `commander` - CLI parsing
- `vite` - Frontend bundling (user project)

---

## Request Lifecycle

### Runtime Request Flow

```
┌──────────┐     HTTP      ┌─────────────────────────────────────────────────┐
│  Client  │──────────────►│              Rust HTTP Server                   │
└──────────┘               │                  (port 3000)                    │
                           ├─────────────────────────────────────────────────┤
                           │                                                 │
                           │  1. Parse HTTP request (zero-copy)              │
                           │     └─► HttpParser extracts method, path,       │
                           │         headers, body offset                    │
                           │                                                 │
                           │  2. Route matching (radix tree)                 │
                           │     └─► Router.at(method, path) → Handler       │
                           │     └─► Extract path parameters                 │
                           │                                                 │
                           │  3. Check handler type                          │
                           │     ├─► Rust handler: Execute directly          │
                           │     └─► TypeScript handler: Proxy via IPC       │
                           │                                                 │
                           └──────────────────┬──────────────────────────────┘
                                              │
                           ┌──────────────────▼──────────────────────────────┐
                           │           IPC (Unix Domain Socket)              │
                           │                                                 │
                           │  4. Serialize request to JSON                   │
                           │     { type: "invoke_handler",                   │
                           │       handler_id: "api_users_get",              │
                           │       request: { method, path, params, ... } }  │
                           │                                                 │
                           └──────────────────┬──────────────────────────────┘
                                              │
                           ┌──────────────────▼──────────────────────────────┐
                           │          TypeScript IPC Server                  │
                           │                                                 │
                           │  5. Route to registered handler                 │
                           │     handlers.get("api_users_get")(request)      │
                           │                                                 │
                           │  6. Execute handler function                    │
                           │     └─► API route: GET/POST/PUT/DELETE export   │
                           │                                                 │
                           │  7. Return response                             │
                           │     { type: "handler_response",                 │
                           │       status: 200,                              │
                           │       headers: { "Content-Type": "..." },       │
                           │       body: "{ ... }" }                         │
                           │                                                 │
                           └──────────────────┬──────────────────────────────┘
                                              │
                           ┌──────────────────▼──────────────────────────────┐
                           │              HTTP Response                      │
                           │                                                 │
                           │  8. Rust converts IPC response to HTTP          │
                           │  9. Send response to client                     │
                           │                                                 │
                           └─────────────────────────────────────────────────┘
```

### Handler Registration

When the Zap server starts:

1. **TypeScript side** reads `routeManifest.json`
2. **Dynamically imports** each route file (`routes/api/*.ts`)
3. **Extracts HTTP method exports** (GET, POST, PUT, DELETE, PATCH)
4. **Registers handlers** with IPC server using handler IDs
5. **Sends route config** to Rust binary via config file

```typescript
// Example: routes/api/users.$id.ts becomes handler_id: "api_users_$id_get"
export const GET = async (req: ZapRequest) => {
  return { id: req.params.id, name: "User" };
};
```

---

## IPC Protocol

Communication between Rust and TypeScript uses **Unix Domain Sockets** with **newline-delimited JSON (NDJSON)**.

### Message Types

```typescript
// Request: Rust → TypeScript
{
  "type": "invoke_handler",
  "handler_id": "api_users_get",
  "request": {
    "method": "GET",
    "path": "/api/users/123",
    "path_only": "/api/users/123",
    "query": { "limit": "10" },
    "params": { "id": "123" },
    "headers": { "Host": "localhost", "Accept": "application/json" },
    "body": "",
    "cookies": {}
  }
}

// Response: TypeScript → Rust
{
  "type": "handler_response",
  "handler_id": "api_users_get",
  "status": 200,
  "headers": { "Content-Type": "application/json" },
  "body": "{\"id\":123,\"name\":\"John\"}"
}

// Health Check
{ "type": "health_check" }
{ "type": "health_check_response" }

// Error
{
  "type": "error",
  "code": "HANDLER_NOT_FOUND",
  "message": "No handler registered for api_users_get"
}
```

### Socket Path

Default: `/tmp/zap-{pid}.sock`

Configurable via `ZapConfig.ipc_socket_path`

---

## Build Pipeline

### Development Mode (`zap dev`)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            zap dev                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │  DevServer      │ Orchestrates all components                            │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│  ┌────────┼────────┬────────────────┬─────────────────┬──────────────────┐  │
│  │        │        │                │                 │                  │  │
│  ▼        ▼        ▼                ▼                 ▼                  │  │
│ ┌────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐ ┌───────────────┐        │  │
│ │Rust│ │Codegen │ │  Route   │ │    Vite     │ │  Hot Reload   │        │  │
│ │Bld │ │ Runner │ │ Scanner  │ │   Proxy     │ │   Server      │        │  │
│ └──┬─┘ └────┬───┘ └────┬─────┘ └──────┬──────┘ └───────┬───────┘        │  │
│    │        │          │              │                │                │  │
│    │ cargo  │ zap-     │ @zapjs/      │ localhost      │ WebSocket      │  │
│    │ build  │ codegen  │ router       │ :5173          │ :3001          │  │
│    │        │          │              │                │                │  │
│    ▼        ▼          ▼              ▼                ▼                │  │
│ ┌──────┐ ┌────────┐ ┌────────────┐ ┌────────┐ ┌─────────────────┐       │  │
│ │ zap  │ │server.ts│ │routeTree.ts│ │Frontend│ │ Reload signals  │       │  │
│ │binary│ │backend.ts││manifest.json│ │  HMR   │ │ to browser      │       │  │
│ └──────┘ └────────┘ └────────────┘ └────────┘ └─────────────────┘       │  │
│                                                                             │
│  File Watcher (chokidar)                                                    │
│  └─► .rs changes  → Rust rebuild → Codegen → Hot reload                     │
│  └─► routes/ changes → Route scan → Hot reload                              │
│  └─► src/ changes → Vite HMR                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Production Build (`zap build`)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            zap build                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: Compile Rust                                                       │
│  ─────────────────────                                                      │
│  cargo build --release                                                      │
│  └─► LTO=fat, codegen-units=1, panic=abort                                  │
│  └─► Output: target/release/zap (~4MB stripped)                             │
│                                                                             │
│  Step 2: Build Frontend                                                     │
│  ──────────────────────                                                     │
│  npx vite build                                                             │
│  └─► React bundle with code splitting                                       │
│  └─► Output: dist/static/                                                   │
│                                                                             │
│  Step 3: Generate Config                                                    │
│  ────────────────────────                                                   │
│  Create dist/config.json with routes, middleware, static file config        │
│                                                                             │
│  Step 4: Create Manifest                                                    │
│  ─────────────────────────                                                  │
│  dist/manifest.json with build metadata                                     │
│                                                                             │
│  Output Structure:                                                          │
│  ─────────────────                                                          │
│  dist/                                                                      │
│  ├── bin/zap              # Rust binary                                     │
│  ├── static/              # Frontend assets                                 │
│  │   ├── index.html                                                         │
│  │   └── assets/                                                            │
│  ├── config.json          # Server configuration                            │
│  └── manifest.json        # Build metadata                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File-Based Routing

Zap.js uses TanStack Router-style file conventions for automatic route discovery.

### Route Patterns

| Pattern | Example File | URL Path |
|---------|--------------|----------|
| `index.tsx` | `routes/index.tsx` | `/` |
| `name.tsx` | `routes/about.tsx` | `/about` |
| `$param.tsx` | `routes/$postId.tsx` | `/:postId` |
| `name.$param.tsx` | `routes/users.$id.tsx` | `/users/:id` |
| `_layout.tsx` | `routes/_layout.tsx` | (pathless layout) |
| `__root.tsx` | `routes/__root.tsx` | (root layout) |
| `(group)/` | `routes/(admin)/` | (route group, no URL) |
| `-excluded/` | `routes/-utils/` | (excluded from routing) |
| `api/*.ts` | `routes/api/users.ts` | `/api/users` |

### API Route Structure

```typescript
// routes/api/users.$id.ts

// Zaptest example
export const GET = async (req: ZapRequest) => {
  const userId = req.params.id;
  return { id: userId, name: `User ${userId}` };
};

export const PUT = async (req: ZapRequest) => {
  const body = JSON.parse(req.body);
  return { updated: true, ...body };
};

export const DELETE = async (req: ZapRequest) => {
  return { deleted: req.params.id };
};
```

### ZapRequest Interface

```typescript
interface ZapRequest {
  method: string;
  path: string;           // Full path with query string
  path_only: string;      // Path without query string
  query: Record<string, string>;
  params: Record<string, string>;  // Route parameters
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}
```

---

## Code Generation

### Rust → TypeScript Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Code Generation Pipeline                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Developer writes Rust function                                          │
│  ──────────────────────────────────                                         │
│     #[zap::export]                                                          │
│     pub async fn get_user(id: u64) -> Result<User, Error> {                 │
│         // implementation                                                   │
│     }                                                                       │
│                                                                             │
│  2. zap-macros processes at compile time                                    │
│  ─────────────────────────────────────────                                  │
│     - Generates wrapper: __zap_wrapper_get_user()                           │
│     - Emits metadata: __ZAP_EXPORT_GET_USER                                 │
│                                                                             │
│  3. zap-codegen reads metadata                                              │
│  ─────────────────────────────────                                          │
│     - Parses exported function info                                         │
│     - Converts types: u64 → number, Result<T,E> → Promise<T>                │
│                                                                             │
│  4. Generates TypeScript files                                              │
│  ─────────────────────────────────                                          │
│                                                                             │
│     // server.ts (namespaced client)                                        │
│     export const server = {                                                 │
│       users: {                                                              │
│         async get(params: { id: number }): Promise<User> {                  │
│           return rpcCall<User>('users.get', { id: params.id });             │
│         }                                                                   │
│       }                                                                     │
│     } as const;                                                             │
│                                                                             │
│     // backend.ts (flat exports)                                            │
│     export async function getUser(id: number): Promise<User> {              │
│       return rpcCall('get_user', { id });                                   │
│     }                                                                       │
│                                                                             │
│     // backend.d.ts (type definitions)                                      │
│     export interface ZapBackend {                                           │
│       getUser(id: number): Promise<User>;                                   │
│     }                                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Type Mapping

| Rust Type | TypeScript Type |
|-----------|-----------------|
| `String`, `&str` | `string` |
| `bool` | `boolean` |
| `i8`-`i128`, `u8`-`u128`, `f32`, `f64` | `number` |
| `Option<T>` | `T \| null` |
| `Vec<T>` | `T[]` |
| `HashMap<K, V>` | `Record<K, V>` |
| `Result<T, E>` | `Promise<T>` (errors throw) |
| Custom struct | Interface by name |

---

## Performance Characteristics

### Benchmark Targets

| Metric | Target | Achieved |
|--------|--------|----------|
| Static route lookup | 9ns | ~9ns |
| Dynamic route lookup | 80-200ns | ~80ns |
| Health check latency | <1ms | <1ms |
| IPC round-trip | ~100μs | ~100μs |
| Dev binary size | <10MB | ~8MB |
| Prod binary size | <5MB | ~4MB (stripped) |

### Optimization Techniques

**Zero-Copy Parsing:**
- `Params<'a>` uses borrowed string slices
- `Headers<'a>` references original request buffer
- `ParsedRequest<'a>` stores body offset, not copy

**Radix Tree Router:**
- O(log n) for dynamic paths
- O(1) for static paths (hash-based)
- Single allocation for parameter extraction

**SIMD Operations:**
- `memchr` for fast byte scanning
- `simdutf8` for UTF-8 validation
- `ahash` for fast hashing

**Release Build:**
```toml
[profile.release]
lto = "fat"           # Link-time optimization
codegen-units = 1     # Single codegen unit
panic = "abort"       # Smaller binary
opt-level = 3         # Maximum optimization
```

---

## Design Decisions

### Why Unix Domain Sockets for IPC?

1. **Performance**: Faster than TCP (no network stack overhead)
2. **Security**: Socket file permissions, no network exposure
3. **Simplicity**: No port management, auto-cleanup
4. **Reliability**: Kernel-level buffering

### Why Separate Rust Binary?

1. **Deployment**: Single binary, no runtime dependencies
2. **Performance**: Native code, no JIT warmup
3. **Memory**: Predictable memory usage
4. **Isolation**: Process-level separation

### Why TanStack-Style Routing?

1. **Familiarity**: Popular convention in React ecosystem
2. **Discoverability**: File structure mirrors URL structure
3. **Colocation**: Route logic near route definition
4. **Type Safety**: Generated route tree with types

### Why Keep TypeScript Handlers?

1. **Ecosystem**: Access to npm packages
2. **Familiarity**: Easier for JavaScript developers
3. **Flexibility**: Complex business logic in TS
4. **Hot Reload**: Fast iteration without Rust recompile

---

## Directory Structure Reference

```
zapjs/
├── packages/
│   ├── core/              # Rust: HTTP primitives
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── router.rs
│   │       ├── radix.rs
│   │       ├── http.rs
│   │       ├── method.rs
│   │       ├── params.rs
│   │       ├── request.rs
│   │       ├── response.rs
│   │       └── middleware.rs
│   ├── server/            # Rust: HTTP server
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── server.rs
│   │       ├── handler.rs
│   │       ├── ipc.rs
│   │       ├── proxy.rs
│   │       ├── config.rs
│   │       └── static.rs
│   ├── macros/            # Rust: #[zap::export]
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs
│   │       └── metadata.rs
│   ├── codegen/           # Rust: TS generator
│   │   └── src/
│   │       ├── main.rs
│   │       └── lib.rs
│   ├── runtime/           # TS: Core wrapper
│   │   └── src/
│   │       ├── index.ts
│   │       ├── process-manager.ts
│   │       ├── ipc-client.ts
│   │       └── rpc-client.ts
│   ├── router/            # TS: File routing
│   │   └── src/
│   │       ├── index.ts
│   │       ├── scanner.ts
│   │       ├── codegen.ts
│   │       ├── watch.ts
│   │       └── types.ts
│   ├── cli/               # TS: CLI tool
│   │   └── src/
│   │       └── commands/
│   │           ├── dev.ts
│   │           ├── build.ts
│   │           ├── serve.ts
│   │           └── routes.ts
│   └── dev-server/        # TS: Dev orchestration
│       └── src/
│           ├── server.ts
│           ├── rust-builder.ts
│           ├── hot-reload.ts
│           └── vite-proxy.ts
├── zaptest/               # Example application
│   ├── routes/
│   │   ├── __root.tsx
│   │   ├── index.tsx
│   │   └── api/
│   │       ├── hello.ts
│   │       ├── users.ts
│   │       └── users.$id.ts
│   ├── src/
│   │   ├── main.tsx
│   │   └── App.tsx
│   └── zap.config.ts
└── docs/                  # Documentation
```

---

## See Also

- [Getting Started](./getting-started.md) - Quick start guide
- [CLI Reference](./api/cli.md) - CLI commands documentation
- [API Routes Guide](./guides/api-routes.md) - Writing API handlers
- [IPC Protocol](./internals/ipc-protocol.md) - Deep dive into IPC
- [Performance](./internals/performance.md) - Optimization details
