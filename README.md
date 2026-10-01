# ZapJS

ZapJS is a Rust-owned React framework. The implementation is organized around one application graph, one Rust request runtime, one embedded React execution host, one Rust TSX build path, and an internal Splice worker boundary for process isolation when the framework chooses to use it.

The final product model mirrors the core deployment shape developers expect from Next.js: a single project produces static assets, browser chunks, server-rendered React output, route handlers, server actions, cache metadata and managed deployment artifacts under one Rust-owned application output.

## Workspace

```text
crates/runtime      route parsing, safe path decoding and compiled lookup
crates/splice       bounded Rust worker transport
crates/render       embedded JavaScript host for React bundles
crates/execute      Rust artifact execution over runtime admission and renderer bundles
crates/build        Rust application graph and TSX/module bundling through Rolldown/Oxc
crates/cli          native ZapJS developer commands
docs/               architecture, runtime and verification evidence
```

## Validation

Run the current implementation with one command:

```sh
CARGO_TARGET_DIR=artifacts/verification/rust-target cargo +1.96.0 test --workspace
```

The recorded Fozzy scenarios in `artifacts/verification/rust-only-crates*.fozzy*` cover the same Rust workspace checks in strict and host-backed modes.

## Status

The Rust foundation is in place and verified at the crate boundary. `zap-cli` now provides native `zap check`, `zap build`, `zap package`, `zap deploy --target local-package` and built-artifact `zap serve` commands over the Rust graph/build/package/execution path. `zap-build` emits and writes the first runtime-owned application manifest, executable page, route-handler and server-action bundles, lazily included React SSR adapters for JSX page entries, a manifest-owned browser action proxy, a Rust-generated browser bootstrap, a Rust deployment manifest, per-callable-export server action IDs, per-export client-reference IDs, route-scoped client-reference IDs, dynamic page params, decoded search params, normalized request headers and bounded UTF-8 request bodies in generated page props and hydration chunk plans from static page/layout imports, typed callable action and route-handler export discovery plus named/default/aliased client-reference discovery and typed named export-list cache metadata discovery, callable route-handler method metadata with GET-to-HEAD derivation, generated GET fallback for HEAD route-handler bundles and browser client chunks for routes, layouts, server action modules, client modules, cache metadata with strict cache export and policy validation, duplicate graph module ID rejection, unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references with regex-literal and non-reference identifier false-positive protection, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection and static assets. `zap-runtime` owns server-action admission with executable action bundle planning and canonical action invocation payloads, page admission with executable page bundle planning and canonical renderer request payloads, route-handler admission with executable route-handler bundle planning and canonical renderer request payloads, GET-to-HEAD route-handler admission, context/auth/deadline policy admission, cache/privacy admission, cache policy validation, cache-control header decisions, body-limit admission, manifest source/bundle path validation, route/action module-kind validation, server-action identity validation, client-reference identity, safe action-proxy path validation, route client-reference membership, hydration chunk planning and browser chunk validation, route-handler method validation, client/server bundle boundary validation, static asset source-path validation and terminal HTTP response mapping. `zap-render` validates route/action `Response` status and headers before response metadata crosses back into Rust and provides Web `Response` helpers for JSON bodies, redirects, cloning and one-shot body reads. `zap-execute` composes runtime admission, execution context policy, application authorization hooks, built artifacts and `zap-render` to execute static assets, manifest-owned browser assets, pages with hydration metadata and bootstrap execution, route handlers with generated Web `Request`/`URL` adapters, structured Zap Flight envelope requests through `ZapRender.flight`, direct server actions and the manifest-owned `/_zap/action` endpoint from a built manifest; the generated browser bootstrap passes the manifest-owned action proxy into client hydrate hooks for browser-to-Rust action calls, intercepts same-origin links for manifest-backed client navigation, aborts superseded navigations, ignores stale responses and exposes pending/error navigation boundary state. The remaining production work is to connect those artifacts into the full React framework vertical slice: production React package integration, full React Flight wire semantics, full React hydration semantics, host-specific upload/lowering and deployed-process verification.
