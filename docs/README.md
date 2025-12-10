# Zap.js Documentation

**Zap.js** is a fullstack web framework combining React (frontend) with Rust (backend). The Rust backend compiles into a high-performance binary that communicates with TypeScript handlers via IPC, delivering exceptional performance while maintaining developer ergonomics.

## Quick Links

| Document | Description |
|----------|-------------|
| [Getting Started](./getting-started.md) | Installation and first project setup |
| [Architecture](./ARCHITECTURE.md) | Technical deep-dive into system design |

## Features

- **Single Binary Deployment** - Rust backend compiles to a standalone executable
- **File-Based Routing** - TanStack Router-style conventions
- **Type-Safe RPC** - Automatic TypeScript bindings from Rust functions
- **Hot Reload** - Full-stack hot reload in development
- **Zero-Copy Performance** - 9ns static route lookups, ~100μs IPC latency

---

## Documentation Index

### API Reference

TypeScript package APIs for building Zap.js applications.

| Document | Package | Description |
|----------|---------|-------------|
| [Runtime API](./api/runtime.md) | `@zapjs/runtime` | Core Zap class, process management, IPC |
| [Router API](./api/router.md) | `@zapjs/router` | File-based routing, route scanning |
| [CLI Reference](./api/cli.md) | `@zapjs/cli` | Command-line tools |
| [Dev Server API](./api/dev-server.md) | `@zapjs/dev-server` | Development orchestration |

### Rust Crates

Low-level Rust crate documentation for contributors and advanced users.

| Document | Crate | Description |
|----------|-------|-------------|
| [zap-core](./rust/zap-core.md) | `zap-core` | HTTP primitives, router, middleware |
| [zap-server](./rust/zap-server.md) | `zap-server` | HTTP server, handlers, IPC proxy |
| [zap-macros](./rust/zap-macros.md) | `zap-macros` | `#[zap::export]` procedural macro |
| [zap-codegen](./rust/zap-codegen.md) | `zap-codegen` | TypeScript binding generator |

### Guides

Step-by-step guides for common tasks.

| Document | Topic |
|----------|-------|
| [File-Based Routing](./guides/file-routing.md) | TanStack-style route conventions |
| [API Routes](./guides/api-routes.md) | Writing HTTP handlers |
| [Server Functions](./guides/server-functions.md) | Rust-to-TypeScript RPC |
| [Deployment](./guides/deployment.md) | Production builds and Docker |

### Internals

Deep technical documentation for understanding the framework internals.

| Document | Topic |
|----------|-------|
| [IPC Protocol](./internals/ipc-protocol.md) | Rust ↔ TypeScript communication |
| [Build Pipeline](./internals/build-pipeline.md) | Dev and production build systems |
| [Performance](./internals/performance.md) | Benchmarks and optimization techniques |

---

## Quick Example

### Project Structure

```
my-zap-app/
├── routes/
│   ├── index.tsx           # / (home page)
│   └── api/
│       └── users.$id.ts    # /api/users/:id
├── src/
│   └── main.tsx            # React entry point
├── zap.config.ts
└── package.json
```

### API Route (routes/api/users.$id.ts)

```typescript
export const GET = async (req: ZapRequest) => {
  return {
    id: req.params.id,
    name: `User ${req.params.id}`,
  };
};

export const DELETE = async (req: ZapRequest) => {
  return { deleted: req.params.id };
};
```

### CLI Commands

```bash
# Development
zap dev                    # Start dev server with hot reload

# Production
zap build                  # Build for production
zap serve                  # Run production server

# Utilities
zap routes                 # Display route tree
zap codegen                # Generate TypeScript bindings
```

---

## Performance

| Metric | Value |
|--------|-------|
| Static route lookup | ~9ns |
| Dynamic route lookup | ~80ns |
| IPC round-trip | ~100μs |
| Production binary | ~4MB |

---

## Requirements

- **Node.js** 18+ or **Bun** 1.0+
- **Rust** 1.70+ (for building the backend)
- **macOS**, **Linux**, or **Windows** (WSL2)

---

## Getting Help

- [GitHub Issues](https://github.com/anthropics/claude-code/issues) - Bug reports and feature requests
- [Architecture Docs](./ARCHITECTURE.md) - Understanding the system design
- [API Reference](./api/runtime.md) - Detailed API documentation
