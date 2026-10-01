# @zap-js/client

The ZapJS framework package includes the compiler, React runtime, CLI, deployment adapters, and optional Rust build integration.

- `zap new <directory>` creates an application.
- `zap dev` develops it with React hot updates.
- `zap build` emits Vercel Build Output API artifacts.
- `zap preview` checks the built application locally.
- `zap routes` inspects the canonical route graph.

Pages and layouts live in `app/`; route handlers export HTTP methods from `route.ts`. Interactive components use `'use client'`; actions use `'use server'`. Import navigation from `@zap-js/client`, request context from `@zap-js/client/server`, and managed Redis caching from `@zap-js/client/cache`.

Optional `native/Cargo.toml` libraries use napi-rs. Server modules import their generated exports from `zap:native`. Native artifacts must be built on the deployment OS and architecture. Edge isolates do not support native Node modules.

This source tree is implementing version 0.3.0. Use a locally packed tarball until release; do not assume older registry versions implement this architecture.
