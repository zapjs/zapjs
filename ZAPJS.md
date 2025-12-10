# ZapJS Implementation Plan & Status

> A fullstack web framework combining React (frontend) and Rust (backend) where the Rust backend is compiled into a binary automatically embedded in the TS/React app, similar to Next.js' hybrid backend-runtime model.

## Current Status: Phase 6 Complete

**Last Updated:** December 2024

---

## Implementation Progress

### Phase 1: Monorepo Restructure ✅ COMPLETE
- [x] Created clean `/packages/` organization
- [x] Setup pnpm workspaces + Cargo workspace
- [x] Reorganized: `core/`, `server/`, `src/` → `packages/`
- [x] 68+ unit tests passing

### Phase 2: Proc Macro System ✅ COMPLETE
- [x] Built `packages/macros/` with `#[zap::export]` macro
- [x] Implemented full type parser using `syn`
- [x] Created metadata extraction system
- [x] Built `packages/codegen/` tool for TypeScript generation
- [x] Auto-generates TS types from Rust functions

### Phase 3: CLI Tool ✅ COMPLETE
- [x] Built `packages/cli/` with full command suite
- [x] `zap new` - Project scaffolding with templates
- [x] `zap build` - Production build orchestration
- [x] `zap serve` - Production server runner
- [x] `zap codegen` - Binding generation
- [x] `zap routes` - Route scanning and tree generation
- [x] Port detection and utilities

### Phase 4: Unified Dev Server ✅ COMPLETE
- [x] Built `packages/dev-server/` orchestration engine
- [x] Rust compilation watching with incremental builds
- [x] TypeScript/Vite dev server integration
- [x] Automatic binding regeneration on Rust changes
- [x] Hot reload WebSocket server
- [x] Keyboard shortcuts (r/c/q)

### Phase 5: Production Features ✅ COMPLETE
- [x] Enhanced build command with LTO optimization
- [x] Production bundle structure (`dist/`)
- [x] Config and manifest generation
- [x] Cross-compilation support
- [x] Docker support (multi-stage build)
- [x] Graceful shutdown handling

### Phase 6: App Router (File-Based Routing) ✅ COMPLETE
- [x] `@zapjs/router` package with TanStack-style conventions
- [x] RouteScanner class for file-based route detection
- [x] Route tree code generation (`routeTree.ts`, `routeManifest.json`)
- [x] File watcher for dev mode route updates
- [x] Runtime integration (`useFileRouting()`)
- [x] Server functions style (`server.users.get()`)
- [x] API routes in separate `routes/api/` folder

### Phase 7: create-zap-app ✅ COMPLETE
- [x] `npx create-zap-app` scaffolding
- [x] Interactive template selection
- [x] Package manager selection (npm/pnpm/bun)
- [x] Git/npm initialization
- [x] Full project template with routes

---

## Remaining Work

### Phase 8: Enhanced RPC ⏳ NOT STARTED
- [ ] MessagePack serialization (currently JSON)
- [ ] Streaming support
- [ ] WebSocket mode option

### Phase 9: Edge/WASM Runtime ⏳ NOT STARTED
- [ ] Compile Rust to WASM
- [ ] Vercel/Cloudflare Workers support
- [ ] Deno Deploy support

---

## Package Status

| Package | Status | Description |
|---------|--------|-------------|
| `@zapjs/runtime` | ✅ Complete | TS wrapper, IPC client, process manager, file routing |
| `@zapjs/cli` | ✅ Complete | CLI commands (new, dev, build, serve, codegen, routes) |
| `@zapjs/dev-server` | ✅ Complete | Dev orchestration, file watching, hot reload, route watching |
| `@zapjs/router` | ✅ Complete | File-based routing (TanStack style), route tree generation |
| `create-zap-app` | ✅ Complete | Interactive project scaffolding |
| `zap-core` | ✅ Complete | Radix router, HTTP parser, middleware |
| `zap-server` | ✅ Complete | HTTP server, IPC proxy, static files |
| `zap-macros` | ✅ Complete | `#[zap::export]` proc macro |
| `zap-codegen` | ✅ Complete | TS binding generator with namespaced server client |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Developer Machine                        │
├─────────────────────────────────────────────────────────────┤
│  zap dev                                                     │
│  ├── RustBuilder (cargo build --release)                    │
│  ├── CodegenRunner (zap-codegen)                            │
│  ├── RouteScannerRunner (@zapjs/router)                     │
│  ├── ViteProxy (frontend HMR)                               │
│  ├── HotReloadServer (WebSocket :3001)                      │
│  └── FileWatcher (chokidar)                                 │
├─────────────────────────────────────────────────────────────┤
│  Runtime                                                     │
│  ├── Zap Binary (Rust HTTP Server :3000)                    │
│  │   ├── Radix Router (9ns static, 80ns dynamic)            │
│  │   ├── Middleware Chain (CORS, logging, compression)      │
│  │   ├── Static File Server                                 │
│  │   └── IPC Proxy → TypeScript Handlers                    │
│  └── IPC Server (Unix Socket)                               │
│      └── TypeScript Handler Dispatch                        │
└─────────────────────────────────────────────────────────────┘
```

---

## CLI Commands

```bash
# Development
zap dev                    # Start dev server with hot reload
zap dev --port 4000        # Custom API port
zap dev --vite-port 5174   # Custom Vite port
zap dev --skip-build       # Skip initial Rust build

# Production
zap build                  # Build for production
zap build --output ./out   # Custom output directory
zap build --target x86_64-unknown-linux-gnu  # Cross-compile
zap build --skip-frontend  # Skip Vite build

zap serve                  # Run production server
zap serve --port 8080      # Custom port
zap serve --config ./cfg   # Custom config file
zap serve --workers 4      # Worker threads

# Scaffolding
zap new my-app             # Create new project
zap new my-app -t fullstack

# Routes
zap routes                 # Scan and display routes
zap routes --json          # Output as JSON
zap routes -o ./src/gen    # Custom output directory

# Codegen
zap codegen                # Generate TS bindings
zap codegen -o ./src/api   # Custom output

# Create new app (standalone)
npx create-zap-app my-app
bunx create-zap-app my-app
```

---

## File-Based Routing (TanStack Style)

### Route Conventions

| Pattern | Example | URL |
|---------|---------|-----|
| `index.tsx` | `routes/index.tsx` | `/` |
| `$param.tsx` | `routes/$postId.tsx` | `/:postId` |
| `name.$param.tsx` | `routes/posts.$postId.tsx` | `/posts/:postId` |
| `_layout.tsx` | `routes/_layout.tsx` | Pathless layout wrapper |
| `__root.tsx` | `routes/__root.tsx` | Root layout |
| `(group)/` | `routes/(admin)/` | Route group (no URL segment) |
| `-excluded/` | `routes/-utils/` | Excluded from routing |
| `api/*.ts` | `routes/api/users.ts` | API route |

### Directory Structure

```
project/
├── routes/
│   ├── __root.tsx           # Root layout
│   ├── index.tsx            # /
│   ├── about.tsx            # /about
│   ├── posts/
│   │   ├── index.tsx        # /posts
│   │   └── $postId.tsx      # /posts/:postId
│   └── api/                 # API routes folder
│       ├── hello.ts         # /api/hello
│       └── users.$id.ts     # /api/users/:id
├── server/                  # Rust handlers
│   └── src/
│       └── main.rs
└── src/generated/           # Auto-generated
    ├── routeTree.ts
    ├── routeManifest.json
    └── server.ts
```

### API Route Example

```typescript
// routes/api/users.$id.ts
export const GET = async ({ params }: { params: { id: string } }) => {
  return {
    id: params.id,
    name: `User ${params.id}`,
  };
};

export const DELETE = async ({ params }: { params: { id: string } }) => {
  // Delete user
  return { deleted: params.id };
};
```

### Server Functions

```typescript
// Generated: src/generated/server.ts
import { server } from './server';

// Namespaced access
const user = await server.users.get({ id: 123 });
const posts = await server.posts.list({ page: 1 });
```

---

## Goals Checklist (from original spec)

| Goal | Status |
|------|--------|
| Unify frontend and backend | ✅ Done |
| Rust as the backend runtime | ✅ Done |
| React as the frontend runtime | ✅ Done (Vite) |
| Automatic TS bindings | ✅ Done |
| Portable backend binary | ✅ Done |
| TanStack-style app router | ✅ Done |
| Zero config dev environment | ✅ Done |
| Hot reload for Rust and TS | ✅ Done |

---

## Core Concepts Status

### Backend Binary ✅
- [x] Rust backend compiled to single static binary
- [x] Transport: Unix domain socket IPC
- [x] Native binary mode
- [ ] WASM native mode
- [ ] Edge mode

### Interaction Layer ✅
- [x] Auto-generated TS bindings (via zap-codegen)
- [x] Rust macros (`#[zap::export]`)
- [x] Strongly typed RPC model
- [x] Namespaced server client (`server.users.get()`)

### App Router ✅
- [x] File-based routes (TanStack style)
- [x] Server functions
- [x] API routes
- [x] Route tree generation
- [x] File watching in dev mode

### Dev Server ✅
- [x] Hot reload frontend
- [x] Hot reload Rust
- [x] Hot reload routes
- [x] Automatic restart on Rust build
- [x] Binary embed rebuild

### Build Pipeline ✅
- [x] Compile Rust backend
- [x] Extract exported functions
- [x] Generate TS bindings
- [x] Generate route tree
- [x] Bundle binary into build output
- [x] Create single deployable artifact

---

## IPC Protocol

**Transport:** Unix domain socket (newline-delimited JSON)

```typescript
// Invoke TypeScript handler
{ type: "invoke_handler", handler_id: "get_users", request: {...} }

// Handler response
{ type: "handler_response", handler_id: "get_users", status: 200, headers: {...}, body: "..." }

// Error
{ type: "error", code: "HANDLER_NOT_FOUND", message: "..." }

// Health check
{ type: "health_check" } → { type: "health_check_response" }
```

---

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| Static route lookup | 9ns | ✅ Achieved |
| Dynamic route lookup | 80-200ns | ✅ Achieved |
| Health check latency | <1ms | ✅ Achieved |
| IPC round-trip | ~100μs | ✅ Achieved |
| Binary size (dev) | <10MB | ✅ ~8MB |
| Binary size (prod) | <5MB | ✅ ~4MB stripped |

---

## Deployment

### Docker
```dockerfile
# Multi-stage build included
docker build -t my-zap-app .
docker run -p 3000:3000 my-zap-app
```

### Manual
```bash
zap build
cd dist
./bin/zap
```

### Production Bundle Structure
```
dist/
├── bin/
│   └── zap              # Rust binary
├── static/              # Frontend assets (if Vite configured)
├── config.json          # Server configuration
└── manifest.json        # Build metadata
```

---

## Next Steps (Priority Order)

1. **Enhanced RPC** - MessagePack serialization, streaming support
2. **Windows Support** - Named pipes instead of Unix sockets
3. **WASM Runtime** - Edge deployment support
4. **Documentation** - Full API docs and tutorials

---

## Contributing

See `CONTRIBUTING.md` (to be created).

## License

MIT
