# ZapJS

ZapJS is an integrated React framework with file-based routing, React Server Components, streaming HTML, server actions, and managed deployment. Optional Rust functions compile to native modules loaded inside the hosting function.

One application owns its pages, layouts, route handlers, client components, and native libraries. The host provides HTTP termination and function lifecycle.

## Development

Requires Node.js 22.15 or later and Bun for repository development. The generated native application pins Rust 1.92.0; JavaScript-only applications do not need a Rust compiler.

```sh
bun install
bun run build
node packages/client/dist/cli/index.js new my-app --no-install
```

The `0.3.0` framework package is under development in this repository. Until it is published, install a locally packed `packages/client` tarball in generated applications instead of resolving that version from the registry.

```sh
npm pack ./packages/client --ignore-scripts
cd my-app
npm install ../zap-js-client-0.3.0.tgz
```

```sh
zap dev
zap build
```

`zap build` generates Vercel Build Output API artifacts in `.vercel/output`. `zap preview` runs the compiled application locally for validation. `zap build --adapter node` emits the internal portable output without producing a managed deployment package.

## Application structure

```text
app/
  layout.tsx           Root HTML document
  page.tsx             Server-rendered home page
  products/[id]/page.tsx
  api/health/route.ts   Web Request/Response handlers
  counter.tsx          Interactive component with 'use client'
native/                Optional Rust cdylib with napi-rs exports
public/                Static files
zap.runtime.ts         Optional server-side cache and authorization configuration
```

Client components import navigation APIs from `@zap-js/client`. Server components, actions, and route handlers import request APIs from `@zap-js/client/server`. Server actions use `'use server'` and must authorize their own application operations. Native exports are server-only imports from `zap:native`.

## Repository

- `packages/client/src/compiler`: canonical route graph and React build integration.
- `packages/client/src/framework`: rendering, navigation, request context, and caching.
- `packages/client/src/adapters`: host request bridge and deployment output.
- `packages/client/src/native`: native compilation and generated bindings.
- `packages/native`: bounded Rust work and cooperative cancellation.
- `tests/fixtures/fullstack`: integrated application used for verification.

## Validation

```sh
bun run verify
```

Redis integration tests require `redis-server` and `redis-cli`. Browser acceptance uses Aegis. Fozzy scenarios under `tests/scenarios` execute actual host commands and produce recorded verification traces.

The obsolete process architecture has been replaced. See [verification evidence and supported limits](docs/implementation.md) before deploying an application; local tests alone do not establish support for every platform or every Next.js feature.

See the [architecture](docs/architecture/framework.md) for the framework contract and performance acceptance criteria.
