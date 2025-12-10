# ZapJS Implementation Plan

> Fullstack web framework: React frontend + Rust backend compiled into a single deployable binary.

**Status:** Phase 7 Complete | **Updated:** December 2024

---

## Completed (Phases 1-7)

| Phase | Summary |
|-------|---------|
| 1. Monorepo | pnpm + Cargo workspaces, `/packages/` structure, 68+ tests |
| 2. Proc Macros | `#[zap::export]`, syn parser, zap-codegen for TS bindings |
| 3. CLI | `zap new/dev/build/serve/codegen/routes` commands |
| 4. Dev Server | Hot reload (Rust + TS), file watching, WebSocket HMR |
| 5. Production | LTO builds, Docker, cross-compilation, graceful shutdown |
| 6. App Router | TanStack-style file routing, API routes, route tree codegen |
| 7. create-zap-app | `npx create-zap-app`, templates, package manager selection |

**All packages complete:** `@zapjs/runtime`, `@zapjs/cli`, `@zapjs/dev-server`, `@zapjs/router`, `create-zap-app`, `zap-core`, `zap-server`, `zap-macros`, `zap-codegen`

**Performance achieved:** 9ns static routes, 80-200ns dynamic, ~100μs IPC, ~4MB binary

---

## Roadmap

### Phase 8: Enhanced RPC
- [ ] MessagePack serialization (replace JSON)
- [ ] Streaming responses
- [ ] WebSocket mode option

### Phase 9: Edge/WASM Runtime
- [ ] Compile Rust to WASM
- [ ] Vercel/Cloudflare Workers support
- [ ] Deno Deploy support

### Phase 10: Production Hardening (HIGH PRIORITY)

#### 10.1 Security
- [ ] Security headers middleware (X-Frame-Options, HSTS, CSP, X-Content-Type-Options)
- [ ] Rate limiting middleware (100 req/min default, configurable per route/IP)
- [ ] Strict CORS by default (require explicit origin list)
- [ ] Request validation framework (zod-style schema validation)

#### 10.2 Observability
- [ ] Prometheus metrics endpoint (`/metrics`)
  - `http_requests_total{method, path, status}`
  - `http_request_duration_seconds{method, path}`
  - `http_requests_in_flight`
- [ ] Request ID correlation (X-Request-ID header, passed through IPC)
- [ ] Structured JSON logging with trace context

#### 10.3 Error Handling
- [ ] React error boundaries (detect `error.tsx`, generate wrappers)
- [ ] `useRouteError()` hook for error pages
- [ ] Graceful fallback UI for unhandled errors

#### 10.4 Caching & Performance
- [ ] ETag generation for static files
- [ ] If-None-Match → 304 Not Modified support
- [ ] Last-Modified headers

#### 10.5 Reliability
- [ ] IPC retry logic (3 retries, exponential backoff)
- [ ] Circuit breaker for persistent handler failures
- [ ] Enhanced health checks (`/health/live`, `/health/ready`)

#### 10.6 Type Safety
- [ ] Replace `any` types in handler signatures
- [ ] Add `TypedHandler<Params, Body, Response>` generics

### Phase 11: Platform Support
- [ ] Windows support (named pipes instead of Unix sockets)

### Phase 12: Documentation
- [ ] OpenAPI/Swagger generation from routes
- [ ] Full API reference docs
- [ ] Tutorial guides

---

## Quick Reference

### CLI Commands
```bash
zap dev                     # Dev server with hot reload
zap build                   # Production build
zap serve                   # Run production server
zap new my-app              # Create project
zap routes                  # Show route tree
zap codegen                 # Generate TS bindings
npx create-zap-app my-app   # Standalone scaffolding
```

### Route Conventions
| Pattern | URL |
|---------|-----|
| `index.tsx` | `/` |
| `$param.tsx` | `/:param` |
| `posts.$id.tsx` | `/posts/:id` |
| `_layout.tsx` | Pathless layout |
| `__root.tsx` | Root layout |
| `(group)/` | Route group |
| `api/*.ts` | API routes |

### API Route Example
```typescript
// routes/api/users.$id.ts
export const GET = async ({ params }: { params: { id: string } }) => {
  return { id: params.id, name: `User ${params.id}` };
};
```

### Architecture
```
Zap Binary (Rust :3000)
├── Radix Router (9ns)
├── Middleware (CORS, logging)
├── Static Files
└── IPC Proxy → TS Handlers (Unix Socket)
```

### Production Bundle
```
dist/
├── bin/zap          # Rust binary
├── static/          # Frontend assets
├── config.json      # Server config
└── manifest.json    # Build metadata
```

---

## License

MIT
