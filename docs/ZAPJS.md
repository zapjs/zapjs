# ZapJS Implementation Plan

> Fullstack web framework: React frontend + Rust backend compiled into a single deployable binary.

**Status:** Phase 11 Complete (Client Router + SSG) | **Updated:** December 2024

---

## Completed (Phases 1-11)

| Phase | Summary |
|-------|---------|
| 1. Monorepo | pnpm + Cargo workspaces, `/packages/` structure, 68+ tests |
| 2. Proc Macros | `#[zap::export]`, syn parser, zap-codegen for TS bindings |
| 3. CLI | `zap new/dev/build/serve/codegen/routes` commands |
| 4. Dev Server | Hot reload (Rust + TS), file watching, WebSocket HMR |
| 5. Production | LTO builds, Docker, cross-compilation, graceful shutdown |
| 6. App Router | Next.js-style file routing `[param]`, API routes, route tree codegen |
| 7. create-zap-app | `npx create-zap-app`, templates, package manager selection |
| **8. Enhanced RPC** | MessagePack, connection pooling, streaming, WebSocket mode |
| **Type Safety** | Full bidirectional Rust↔TypeScript type safety with union types |
| **10.1 Security** | Security headers, rate limiting, strict CORS middleware |
| **10.2 Observability** | Prometheus metrics, X-Request-ID correlation, structured logging |
| **10.3 Error Handling** | React ErrorBoundary, useRouteError hook, errorComponent |
| **10.4 Caching** | ETag generation, Last-Modified, conditional requests (304) |
| **10.5 Reliability** | IPC retry with exponential backoff, circuit breaker, Kubernetes health probes |
| **11. Client Router** | useRouter, useParams, Link, SSG with generateStaticParams |

**All packages complete:** `@zapjs/runtime`, `@zapjs/cli`, `@zapjs/dev-server`, `@zapjs/router`, `create-zap-app`, `zap-core`, `zap-server`, `zap-macros`, `zap-codegen`

**Performance achieved:** 9ns static routes, 80-200ns dynamic, ~100μs IPC, ~4MB binary

---

## Roadmap

### Phase 8: Enhanced RPC ✅ COMPLETE
- [x] MessagePack serialization (default, ~40% faster than JSON)
- [x] Connection pooling (4 persistent connections, round-robin)
- [x] Streaming responses (AsyncIterable handlers)
- [x] WebSocket mode (bidirectional real-time communication)

### Phase 9: Edge/WASM Runtime
- [ ] Compile Rust to WASM
- [ ] Vercel/Cloudflare Workers support
- [ ] Deno Deploy support

### Phase 10: Production Hardening

#### 10.1 Security ✅ COMPLETE
- [x] Security headers middleware (X-Frame-Options, HSTS, CSP, X-Content-Type-Options)
- [x] Rate limiting middleware (100 req/min default, pluggable storage: memory/Redis)
- [x] Strict CORS by default (require explicit origin list)
- [ ] Request validation framework (zod-style schema validation) - *deferred*

#### 10.2 Observability ✅ COMPLETE
- [x] Prometheus metrics endpoint (`/metrics`)
  - `http_requests_total{method, path, status}`
  - `http_request_duration_seconds{method, path}`
  - `http_requests_in_flight`
- [x] Request ID correlation (X-Request-ID header, passed through IPC)
- [x] Structured JSON logging with trace context

#### 10.3 Error Handling ✅ COMPLETE
- [x] React ErrorBoundary with TanStack-style `errorComponent` prop
- [x] `useRouteError()` hook for error pages
- [x] DefaultErrorComponent fallback UI
- [x] Route scanner detects `errorComponent` exports
- [x] Codegen wires error components automatically

#### 10.4 Caching & Performance ✅ COMPLETE
- [x] ETag generation (weak by default, strong SHA256 optional)
- [x] If-None-Match → 304 Not Modified support
- [x] If-Modified-Since → 304 Not Modified support
- [x] Last-Modified headers (RFC 7231 format)
- [x] Configurable per-handler caching options

#### 10.5 Reliability ✅ COMPLETE
- [x] IPC retry logic (3 retries, exponential backoff with full jitter)
- [x] Circuit breaker for persistent handler failures (CLOSED/OPEN/HALF_OPEN)
- [x] Enhanced health checks (`/health/live`, `/health/ready`)

#### 10.6 Type Safety ✅ COMPLETE
- [x] Full bidirectional Rust↔TypeScript type safety
- [x] `Result<T, ApiError>` return types generate `T | ApiError` union types
- [x] Automatic codegen from Rust source (no manual type definitions)
- [x] 19 typed response interfaces generated automatically
- [x] Discriminated union pattern for error handling

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

### Route Conventions (Next.js Style)
| Pattern | URL |
|---------|-----|
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `[id].tsx` | `/:id` (dynamic) |
| `[...slug].tsx` | `/*slug` (catch-all) |
| `[[...slug]].tsx` | `/*slug?` (optional catch-all) |
| `posts.[id].tsx` | `/posts/:id` |
| `_layout.tsx` | Scoped layout |
| `__root.tsx` | Root layout |
| `(group)/` | Route group (no URL) |
| `_private/` | Excluded folder |
| `api/*.ts` | API routes |

### API Route Example
```typescript
// routes/api/users.[id].ts
export const GET = async ({ params }: { params: { id: string } }) => {
  return { id: params.id, name: `User ${params.id}` };
};
```

### Client Router
```typescript
import { RouterProvider, useRouter, useParams, Link } from '@zapjs/runtime';

// Navigation
const router = useRouter();
router.push('/posts/123');
router.back();

// Params
const { id } = useParams<{ id: string }>();

// Links (SPA navigation)
<Link to="/posts/123">View Post</Link>
<NavLink to="/dashboard" activeClassName="active">Dashboard</NavLink>
```

### SSG (Static Site Generation)
```typescript
// routes/posts/[id].tsx
export async function generateStaticParams() {
  const posts = await getPosts();
  return posts.map(post => ({ id: post.id }));
}

export default function PostPage({ params }: { params: { id: string } }) {
  // Pre-rendered at build time for each id
}
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

## Production Features (Phase 10)

### Security (10.1)

**Security Headers** - Applied automatically to all responses:
```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: <configurable>
```

**Rate Limiting** - Token bucket algorithm per IP:
- Default: 100 requests/minute
- Returns 429 with `Retry-After` header
- Pluggable storage (in-memory default, Redis optional)

**Strict CORS** - Explicit origin allowlist required:
```typescript
cors: {
  origins: ['https://app.example.com'],
  methods: ['GET', 'POST'],
  credentials: true,
}
```

### Enhanced RPC (Phase 8)

**MessagePack Serialization** - Default protocol, ~40% faster than JSON:
```
Frame format: [4-byte big-endian length][payload]
Auto-detect: First byte 0x7B = JSON, else MessagePack
```

**Connection Pooling** - Eliminates per-request connection overhead:
- 4 persistent connections (configurable)
- Round-robin distribution
- Automatic reconnection on failure
- Health checks with keep-alive

**Streaming Responses** - For large payloads and real-time data:
```typescript
// routes/api/stream.ts
export const GET = async function* ({ params }) {
  yield { data: 'chunk 1\n' };
  yield { data: 'chunk 2\n' };
  yield { bytes: new Uint8Array([1, 2, 3]) };
};
```

**WebSocket Mode** - Bidirectional real-time communication:
```typescript
// routes/api/chat.ts (WEBSOCKET export)
export const WEBSOCKET = {
  onConnect: async (socket) => {
    console.log('Client connected:', socket.id);
  },
  onMessage: async (socket, message) => {
    socket.send(`Echo: ${message}`);
  },
  onClose: async (socket, code, reason) => {
    console.log('Client disconnected');
  },
};

// routes/ws/chat.ts (default export in ws/ folder)
export default {
  onConnect: async (socket) => { /* ... */ },
  onMessage: async (socket, message) => { /* ... */ },
  onClose: async (socket, code, reason) => { /* ... */ },
};
```

### Caching (10.4)

**ETag Generation** - Automatic cache validation:
```typescript
// Weak ETag (default): W/"size-mtime_hex" - fast, no hashing
// Strong ETag: "sha256_hex" - content-based, precise

staticFiles: {
  etag_strategy: 'weak',  // 'weak' | 'strong' | 'none'
}
```

**Conditional Requests** - Returns 304 Not Modified when:
- `If-None-Match` header matches ETag
- `If-Modified-Since` header is after Last-Modified

**Last-Modified Headers** - RFC 7231 format:
```
Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT
```

**Configuration**:
```typescript
staticFiles: {
  etag_strategy: 'weak',
  enable_last_modified: true,
  cache_control: 'public, max-age=3600',
}
```

### Observability (10.2)

**Prometheus Metrics** at `/metrics`:
```
http_requests_total{method="GET", path="/api/users", status="200"} 1234
http_request_duration_seconds{method="GET", path="/api/users"} 0.015
http_requests_in_flight 5
ipc_invoke_duration_seconds{handler_id="handler_0"} 0.008
```

**Request ID Correlation**:
- Incoming `X-Request-ID` header preserved
- Auto-generated UUID if not present
- Passed through IPC to TypeScript handlers
- Included in all log entries

**Structured Logging**:
```typescript
import { logger } from '@zapjs/runtime';

logger.info('User created', { request_id, userId: '123' });
// {"level":"info","message":"User created","request_id":"abc-123","userId":"123","timestamp":"..."}
```

### Reliability (10.5)

**IPC Retry Logic** - Exponential backoff with full jitter:
```typescript
// Default configuration:
// - Base delay: 100ms
// - Max delay: 10s
// - Max retries: 3
// - Formula: min(max_delay, base_delay * 2^attempt) * random(0, 1)

// Automatic retry for transient failures
// Non-retryable errors (400, 401, 403, 429) fail immediately
```

**Circuit Breaker** - Prevents cascading failures:
```typescript
// States: CLOSED → OPEN → HALF_OPEN → CLOSED
// Configuration:
circuit_breaker: {
  failure_threshold: 5,      // Open after 5 failures
  reset_timeout: '30s',      // Wait before half-open
  success_threshold: 3,      // Close after 3 successes
  failure_window: '60s',     // Failure counting window
}

// When OPEN: Returns 503 Service Unavailable immediately
// Handler/validation errors don't trigger circuit breaker
```

**Enhanced Health Checks** - Kubernetes-style probes:
```typescript
// GET /health/live - Liveness probe
// Returns 200 if process is alive, 503 if not
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_secs": 3600,
  "components": [{ "name": "process", "status": "healthy" }]
}

// GET /health/ready - Readiness probe
// Checks connection pool and circuit breaker
{
  "status": "healthy",  // or "degraded", "unhealthy"
  "components": [
    { "name": "connection_pool", "status": "healthy", "message": "4/4 connections healthy" },
    { "name": "circuit_breaker", "status": "healthy", "message": "Circuit is CLOSED" }
  ]
}

// Usage in server configuration:
server.health_endpoints()  // Registers /health/live and /health/ready
```

### Client Router (Phase 11)

**RouterProvider** - Wrap your app:
```typescript
import { RouterProvider, Outlet } from '@zapjs/runtime';
import { routeDefinitions } from './generated/routerConfig';

function App() {
  return (
    <RouterProvider routes={routeDefinitions}>
      <nav>...</nav>
      <Outlet />
    </RouterProvider>
  );
}
```

**Hooks** - Standard React patterns:
```typescript
import { useRouter, useParams, usePathname, useSearchParams } from '@zapjs/runtime';

function MyComponent() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const [searchParams, setSearchParams] = useSearchParams();

  // Navigate programmatically
  router.push('/posts/123');
  router.replace('/login');
  router.back();
  router.prefetch('/dashboard');
}
```

**Link & NavLink** - SPA navigation:
```typescript
import { Link, NavLink } from '@zapjs/runtime';

<Link to="/posts/123">View Post</Link>
<Link to="/posts/123" replace>Replace History</Link>
<NavLink to="/dashboard" activeClassName="active">Dashboard</NavLink>
```

### SSG (Phase 11)

**generateStaticParams** - Pre-render dynamic routes at build time:
```typescript
// routes/posts/[id].tsx
export async function generateStaticParams() {
  const posts = await fetchPosts();
  return posts.map(post => ({ id: post.id }));
}

export default function PostPage({ params }: { params: { id: string } }) {
  // This page will be pre-rendered for each id returned above
}
```

**Build-time generation**:
- Route scanner detects `generateStaticParams` exports
- Build process calls each function to collect params
- Static HTML generated at `dist/posts/[id]/index.html`
- SSG manifest tracks all pre-rendered paths

### Error Handling (10.3)

**errorComponent** - Export from route files:
```typescript
// routes/users.[id].tsx
export default function UserPage({ params }) {
  return <UserProfile userId={params.id} />;
}

export function errorComponent({ error, reset }) {
  return (
    <div>
      <h1>Failed to load user</h1>
      <p>{error.message}</p>
      {error.digest && <small>Error ID: {error.digest}</small>}
      <button onClick={reset}>Try Again</button>
    </div>
  );
}
```

**useRouteError Hook**:
```typescript
import { useRouteError } from '@zapjs/runtime';

export function errorComponent() {
  const { error, reset } = useRouteError();
  return <MyErrorUI error={error} onRetry={reset} />;
}
```

**ZapRouteError Interface**:
```typescript
interface ZapRouteError {
  message: string;
  code?: string;      // "HANDLER_ERROR", "VALIDATION_ERROR", etc.
  status?: number;    // HTTP status code
  digest?: string;    // Server error correlation ID
  stack?: string;     // Stack trace (dev only)
  details?: Record<string, unknown>;
}
```

---

## Bidirectional Type Safety (Core Feature)

ZapJS provides **zero-cost bidirectional type safety** between Rust and TypeScript - the core differentiator of the framework.

### How It Works

1. **Rust functions** use `#[export]` macro with typed returns:
```rust
#[export]
pub fn list_users(limit: u32, offset: u32) -> Result<ListUsersResponse, ApiError> {
    // Implementation
}
```

2. **Codegen** scans Rust source and generates TypeScript:
```typescript
// Auto-generated
async listUsers(limit: number, offset: number): Promise<ListUsersResponse | ApiError>
```

3. **TypeScript** gets full type safety with discriminated unions:
```typescript
const result = await backend.listUsers(10, 0);
if ('error' in result) {
  // TypeScript KNOWS this is ApiError
  console.error(result.code);
} else {
  // TypeScript KNOWS this is ListUsersResponse
  console.log(result.users, result.total);
}
```

### Generated Files

| File | Purpose |
|------|---------|
| `types.ts` | All Rust structs as TypeScript interfaces |
| `backend.ts` | Flat function exports with full types |
| `server.ts` | Namespaced server client |
| `backend.d.ts` | Type declarations |

### Type Mappings

| Rust | TypeScript |
|------|------------|
| `String` | `string` |
| `u32`, `i32`, `usize` | `number` |
| `bool` | `boolean` |
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` |
| `HashMap<K, V>` | `Record<K, V>` |
| `Result<T, E>` | `T \| E` (union type) |
| Custom structs | Generated interfaces |

### Automatic Struct Detection

Any struct with `#[derive(Serialize)]` is automatically converted:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}
```

Generates:
```typescript
export interface User {
  id: string;
  name: string;
  createdAt: string;
}
```

---

## Production Readiness Assessment

### Current State: Type-Safe Rust Backend Library

ZapJS is production-ready as a **type-safe Rust RPC backend** - comparable to:
- tRPC (type-safe RPC)
- Remix loaders/actions (server functions)
- SvelteKit form actions

### What's Ready

| Feature | Status |
|---------|--------|
| Bidirectional type safety | ✅ Complete |
| Automatic codegen | ✅ Complete |
| Typed error handling | ✅ Complete |
| HTTP server | ✅ Complete |
| IPC to TypeScript | ✅ Complete |
| File-based routing | ✅ Complete (Next.js style `[param]`) |
| **Client-side router** | ✅ Complete (useRouter, Link, etc.) |
| **SSG (generateStaticParams)** | ✅ Complete |
| Hot reload | ✅ Complete |
| Production builds | ✅ Complete |
| Security headers | ✅ Complete |
| Rate limiting | ✅ Complete |
| Strict CORS | ✅ Complete |
| Prometheus metrics | ✅ Complete |
| Request ID correlation | ✅ Complete |
| Structured logging | ✅ Complete |
| React ErrorBoundary | ✅ Complete |
| useRouteError hook | ✅ Complete |
| MessagePack serialization | ✅ Complete |
| Connection pooling | ✅ Complete |
| Streaming responses | ✅ Complete |
| WebSocket support | ✅ Complete |
| ETag/Last-Modified | ✅ Complete |
| Conditional requests (304) | ✅ Complete |
| IPC retry with backoff | ✅ Complete |
| Circuit breaker | ✅ Complete |
| Kubernetes health probes | ✅ Complete |

### Gaps vs Next.js

| Feature | Next.js | ZapJS |
|---------|---------|-------|
| SSR | Built-in streaming | Not implemented (SSG only) |
| Client Router | Built-in | ✅ useRouter, Link, NavLink |
| SSG | Built-in | ✅ generateStaticParams |
| File routing | `[param]` convention | ✅ Same convention |
| Image optimization | Built-in | None |
| Middleware | Edge middleware | Security, rate limiting, CORS |
| Data fetching | fetch() caching, ISR | Manual |
| Layouts/templates | Nested layouts | Scoped layouts |
| Metadata API | SEO, OpenGraph | None |
| Deployment | Vercel, any Node host | Custom binary |
| Error boundaries | error.tsx convention | errorComponent export |
| Observability | Manual | Prometheus, structured logging |
| WebSocket | Manual | Built-in with IPC bridge |
| Streaming | Server Components | AsyncIterable handlers |
| Caching | Built-in | ETag, Last-Modified, 304 |
| Resilience | Manual | Circuit breaker, retry with backoff |
| Health checks | Manual | Kubernetes-style liveness/readiness |

### Recommended Use Cases

**Good Fit:**
- APIs needing Rust performance (CPU-intensive, real-time)
- Type-safe backend for existing React/Vue/Svelte apps
- Microservices with strict type contracts
- Projects prioritizing type safety over ecosystem

**Not Yet Ready For:**
- Full-stack React apps (use Next.js + ZapJS backend)
- Static site generation
- Edge deployment
- Teams needing extensive documentation/ecosystem

### Path Forward

**Option A: Backend Library** (Current)
Position as a high-performance type-safe backend that complements Next.js/Remix

**Option B: Full Framework** (6-12 months)
Would require: React SSR, build tooling, static generation, edge runtime, docs

---

## License

MIT
