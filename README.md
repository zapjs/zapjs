# ZapJS

ZapJS is a Rust-owned React framework. The implementation is organized around one application graph, one Rust request runtime, one embedded React execution host, one Rust TSX build path, and an internal Splice worker boundary for process isolation when the framework chooses to use it.

The final product model mirrors the core deployment shape developers expect from Next.js: a single project produces static assets, browser chunks, server-rendered React output, route handlers, server actions, cache metadata and managed deployment artifacts. Users do not run a separate application backend or public RPC service.

## Workspace

```text
crates/runtime      route parsing, safe path decoding and compiled lookup
crates/splice       bounded Rust worker transport
crates/render       embedded JavaScript host for React bundles
crates/build        Rust application graph and TSX/module bundling through Rolldown/Oxc
docs/               architecture, runtime and verification evidence
```

## Validation

Run the current implementation with one command:

```sh
CARGO_TARGET_DIR=artifacts/verification/rust-target cargo +1.96.0 test --workspace
```

The recorded Fozzy scenarios in `artifacts/verification/rust-only-crates*.fozzy*` cover the same Rust workspace checks in strict and host-backed modes.

## Status

The Rust foundation is in place and verified at the crate boundary. `zap-build` now emits and writes the first runtime-owned application manifest, executable page and route-handler server bundles, per-export server action IDs, route-handler method metadata and browser client chunks for routes, layouts, server action modules, client modules, cache metadata and static assets. `zap-runtime` owns server-action admission, body-limit admission, static asset source-path validation and terminal HTTP response mapping. The remaining production work is to connect those artifacts into the full React framework vertical slice: production React SSR, Flight, hydration, navigation, Web `Response` route handlers and managed Rust deployment artifacts.
