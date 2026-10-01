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

The Rust foundation is in place and verified at the crate boundary. `zap-build` now emits and writes the first runtime-owned application manifest, executable page, route-handler and server-action bundles, per-export server action IDs, route-handler method metadata with GET-to-HEAD derivation, generated GET fallback for HEAD route-handler bundles and browser client chunks for routes, layouts, server action modules, client modules, cache metadata with strict cache export and policy validation, duplicate graph module ID rejection, Node built-in/platform-module rejection, ambient platform-global rejection with regex-literal and non-reference identifier false-positive protection, static template module-specifier scanning and static assets. `zap-runtime` owns server-action admission, GET-to-HEAD route-handler admission, context/auth/deadline policy admission, cache/privacy admission, cache policy validation, cache-control header decisions, body-limit admission, manifest source/bundle path validation, route/action module-kind validation, server-action identity validation, route-handler method validation, client/server bundle boundary validation, static asset source-path validation and terminal HTTP response mapping. `zap-render` validates route/action `Response` status and headers before response metadata crosses back into Rust. The remaining production work is to connect those artifacts into the full React framework vertical slice: production React SSR, Flight, hydration, navigation, React action wiring and application-specific authorization hooks and managed Rust deployment artifacts.
