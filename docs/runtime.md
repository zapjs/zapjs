# Application runtime

Zap applications use a root `app/layout.tsx` HTML document and `page.tsx` modules. Nested layouts, route groups, `[param]`, `[...param]`, and `[[...param]]` share the compiler's route graph. `loading.tsx`, client `error.tsx`, and root `not-found.tsx` define rendering boundaries. Parallel and intercepting routes are rejected explicitly.

`route.ts` exports HTTP methods accepting Web `Request` and `{ params }`, returning Web `Response`. Streams, binary bodies, repeated response cookies, abort signals and HEAD responses remain native host contracts. Body limits are enforced at the adapter and server-action boundaries.

## Request data

Import `request`, `headers`, `cookies`, and `memoize` from `@zap-js/client/server`. Request data is isolated with AsyncLocalStorage. Headers are returned as a copy. Cookies may be written only during actions or route handling before response streaming; writes force private no-store responses. Request metadata is rejected during public prerendering and within shared-cache loaders.

`memoize(loader)` deduplicates calls within one request by argument identity. It distinguishes null, undefined, object identities and signed zero. Supply an explicit key function only when the application has a sound equality rule for its arguments.

## Server actions

Action modules use `'use server'`. Authorize application operations inside each action. An optional `zap.runtime.ts` `authorizeAction(request)` hook applies an additional request-wide gate to every mutation; it does not replace action-specific authorization. Origin checks and size limits apply before invocation. Return expected validation results as values; unexpected exceptions are redacted with an opaque error identifier in production.

Runtime configuration stays server-side. Client imports of server APIs, native libraries, and Node builtins fail compilation.

Action references are scoped to a build, including forms submitted before hydration. A stale hydrated client receives a deployment-mismatch response; an old progressive form cannot invoke the new build's actions. Mutations are never automatically replayed. Keep application action modules inside the application root so the compiler can enforce this boundary.

## Shared caching

Shared caches are explicit public-data caches. Import `cache` and `revalidateTag` from `@zap-js/client/server`. Configure a `CacheStore` in `zap.runtime.ts`, including a deployment-specific `cacheNamespace`. There is no process-memory fallback pretending to provide shared invalidation.

`@zap-js/client/cache` exports `createRedisCache(executeCommand)` for a Redis client and `createRedisRestCache({ url, token })` for the managed Redis REST protocol. Redis operations check tag generations atomically, so an invalidated in-flight fill cannot repopulate stale data. Values must be JSON primitives, arrays, or plain objects; Date, undefined, nonfinite numbers, cycles and other lossy conversions are rejected.

Shared loaders must be independent of private request state, including values captured in closures. The framework rejects direct request-metadata access inside them, but cannot prove that arbitrary application code has not captured private data. Keep personalized results in request-local memoization.

## Public prerendering

Pages opt in with the literal `export const prerender = true`. Dynamic pages additionally export `generateStaticParams`. The compiler captures HTML and Flight from the same render, rejects request-dependent data and failed/private responses, and emits host routing metadata. Each generated path must resolve back to the page that requested it. It cannot opt another route into public caching.

## Native modules

`zap new app --native` creates a napi-rs library. Its generated bindings are available only to server modules through `zap:native`. Signatures and TypeScript declarations come from the compiled Rust exports. Node-API value conversion replaces serialized IPC messages.

Heavy CPU work uses the packaged `zap-native` compute library. Work admission is bounded and cancellation is cooperative. Code must check its cancellation token at bounded intervals; arbitrary native instructions cannot be forcibly interrupted safely. Native failures share the managed function's process boundary.

Release builds require Cargo.lock and the deployment's OS/architecture. Node-API 8 is the supported baseline. Native Edge/WASM and cross-compilation are not advertised as working targets.

## Initial limits and supported deployment

The managed adapter targets Vercel's Node 22 runtime. JavaScript builds work without a Rust toolchain; native builds must run on matching Linux GNU x64 or arm64 infrastructure. The native scaffold provisions Rust 1.92.0 during its managed build. Local native development supports macOS x64/arm64 and Linux GNU x64/arm64.

The request/action body limit is 1 MiB. HTML hydration and prerender capture enforce an 8 MiB Flight limit before branching streams; the HTML injector also limits pending HTML to 8 MiB. Exceeding a limit fails the render or build and cancels its inputs. Streaming remains demand-driven and scripts are inserted only at complete document head/body boundaries.

This release emits one dynamic managed function with lazy route chunks. Automatic function partitioning, additional managed-platform adapters, Edge execution, nonce-based strict CSP, SRI, image optimization, middleware conventions, and complete Next.js API compatibility are not implemented. Inline React/Flight bootstrap scripts require a compatible application CSP. These are capability boundaries, not silent fallback services.
