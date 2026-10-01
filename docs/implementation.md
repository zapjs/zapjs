# Implementation evidence

Verified October 1, 2026 for the Rust-owned foundation. This page records what is currently proven and what remains open.

## Corrective Rust layer

| Crate | Evidence |
|---|---|
| `zap-runtime` | Owns the shared application manifest schema, validates graph references, parses route patterns, builds a compiled trie, resolves manifest-backed routes, plans request targets for static assets/pages/route handlers, maps terminal admission outcomes to HTTP response contracts, enforces page/asset/handler method policy including executable page bundle planning and canonical renderer request payloads, runtime GET-to-HEAD route-handler admission, executable route-handler bundle planning and canonical renderer request payloads, admits known server actions with POST, same-origin checks, malformed-origin rejection, executable action bundle planning and canonical action invocation payloads, enforces request id/auth/deadline execution policy before dispatch, rejects public cache fills that touched private request state before dispatch, validates route cache policies, maps route cache decisions to cache-control headers, rejects oversized declared request bodies before dispatch, validates manifest source/bundle paths, enforces route/action/client-reference source identity, validates route-scoped client-reference membership, validates the manifest-owned browser action proxy and exposes route hydration plans, enforces route/action/client-reference module-kind boundaries, rejects unsupported route-handler methods, rejects client modules that declare server bundles, validates client-reference browser chunk identity, validates static asset source paths at manifest load and source resolution and rejects malformed, unsafe or ambiguous URL paths. |
| `zap-splice` | Implements bounded Rust-to-Rust unary invocation over Unix streams with version handshake, negotiated frame size, max in-flight admission, typed remote errors, cancellation, deadlines, disconnect cleanup and a real same-binary subprocess fixture. |
| `zap-render` | Runs bundle-produced JavaScript in a Rust-owned QuickJS context with only the installed Web primitives and explicit Rust host calls exposed by default. Tests cover page text output, page Flight output through `ZapRender.flight`, page Web `ReadableStream` output, Web `Request`, `Response`, `URL` and `URLSearchParams` primitives, route-handler text output, server-action `Response` output, route/action error-boundary outcomes, route/action `Response` status/header validation, redirect/json helpers and body adaptation, explicit Rust host calls, absence of ambient platform capabilities, output limits and CPU interruption. |
| `zap-execute` | Loads built manifests, applies runtime request/action admission and execution context policy, runs application authorization hooks, serves static assets and manifest-owned browser assets, executes page HTML, page Flight, route-handler and server-action bundles through `zap-render`, injects route hydration metadata, modulepreload links and the Rust-generated browser bootstrap module script into page HTML, names the action proxy in the hydration payload, handles same-origin client navigation with abort/stale-response protection plus pending/error navigation boundary state through the bootstrap runtime and handles the `/_zap/action` endpoint used by the generated browser proxy. Tests cover page GET/HEAD execution, page Flight request execution, route-handler execution, static assets, browser asset serving, hydration metadata/bootstrap execution, direct server actions, action endpoint success, malformed action payloads, method/path/body/origin endpoint denial, terminal admission responses, context-policy denial and hook denial before artifact execution. |
| `zap-cli` | Provides native `zap check`, `zap build`, `zap package`, `zap deploy --target local-package`, `zap deploy --target managed-native`, `zap deploy --target provider-fs` and `zap serve` commands over the Rust graph/build/package/execution path with explicit root/app/public/output/minification/deployment/manifest/address options. The package command reads `.zap/deployment.json`, validates declared artifact paths, materializes a package root and writes `.zap/package.json`; the deploy command builds, packages and verifies the local-package target through the Rust executor, lowers managed-native output into separate function/static roots with a `zap.managed-native.json` artifact manifest, and uploads managed-native artifacts to a provider filesystem root with a `zap.provider-fs-upload.json` receipt. Tests cover parser behavior, graph validation without artifact writes, invalid graph rejection, a real minimal app build that writes `.zap/manifest.json`, `.zap/deployment.json` and a server bundle, package path-safety rejection, loading the packaged root through the Rust executor, build-to-package deploy verification for the local-package target, managed-native lowering verification, provider filesystem upload verification and process-backed serving of managed-native and provider-uploaded function artifacts. |
| `zap-build` | Builds the runtime-owned application manifest, writes it atomically under `.zap/manifest.json`, writes `.zap/deployment.json` with manifest, server-bundle, browser-asset, static-asset and action-endpoint packaging metadata, emits page server bundles with `ZapRender.render` and `ZapRender.flight` contracts plus a generated React SSR adapter only for JSX page entries that convert page render trees with `react-dom/server.browser` `renderToReadableStream`, emits route-handler server bundles with the `ZapRoute.handle` contract and generated Web `Request`/`URL` adapters, and emits server-action bundles with the `ZapAction.invoke` contract, emits the manifest-owned browser action proxy for same-origin action calls, emits per-callable-export server-action IDs, emits per-export client-reference IDs with browser chunk identity, records route-scoped client references and hydration chunk inputs from static page/layout imports, records callable route-handler methods with GET-to-HEAD derivation, does not emit server bundles for client-only modules and bundles graph modules through Rust Rolldown/Oxc crates. Tests cover route/layout/action-export/handler-method/client-module/client-reference/route-client-reference/hydration-plan/asset/cache discovery, strict cache export and policy validation, duplicate graph module ID rejection, action-module, server-action identity, typed callable export discovery for actions and route handlers plus named/default/aliased client-reference export discovery and typed local named export-list cache metadata discovery, re-export list exclusion until explicit graph resolution exists and callable route-handler export validation, GET-to-HEAD route-handler method derivation, generated GET fallback for HEAD route-handler bundles, ambiguous route rejection, runtime manifest loading, plain text page execution without a React SSR adapter, JSX page rendering and structured page Flight envelope execution through the generated page adapter and `zap-render` including dynamic route params, decoded query values, normalized headers and bounded UTF-8 request bodies in generated page props, route-handler Web `Request` adapter execution and server-action bundle execution through `zap-render` using runtime-generated renderer/action payloads, deployment manifest output, browser action proxy output, browser module output, unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection, regex-literal and non-reference identifier false-positive protection and graph-to-artifact emission without invoking an external JavaScript runtime. |

## Commands run

```sh
CARGO_TARGET_DIR=artifacts/verification/rust-target cargo +1.96.0 test --workspace
```

Results:

- `zap-runtime`: 15 tests passed.
- `zap-splice`: 7 tests passed, 1 ignored subprocess helper invoked by the parent test.
- `zap-render`: 11 tests passed.
- `zap-build`: 14 tests passed.
- `zap-cli`: 15 tests passed.

## Fozzy validation

Strict deterministic validation:

```sh
/Users/deepsaint/.cargo/bin/fozzy doctor --deep --scenario artifacts/verification/rust-only-crates.fozzy.json --runs 5 --seed 42 --json
/Users/deepsaint/.cargo/bin/fozzy test --det --strict-verify artifacts/verification/rust-only-crates.fozzy.json --json
```

Both passed. The strict doctor run reported five identical determinism signatures.

Host-backed recorded validation:

```sh
/Users/deepsaint/.cargo/bin/fozzy run artifacts/verification/rust-only-crates-host.fozzy.json --det --seed 42 --proc-backend host --fs-backend host --http-backend host --record artifacts/verification/rust-only-crates-host.trace.fozzy --json
/Users/deepsaint/.cargo/bin/fozzy trace verify artifacts/verification/rust-only-crates-host.trace.fozzy --strict-verify --json
/Users/deepsaint/.cargo/bin/fozzy replay artifacts/verification/rust-only-crates-host.trace.fozzy --json
/Users/deepsaint/.cargo/bin/fozzy ci artifacts/verification/rust-only-crates-host.trace.fozzy --json
```

The host run, trace verification, replay and CI all passed. The recorded trace reported no memory leaks in Fozzy's trace summary.

## Remaining production gates

The foundation still needs:

1. production React package integration for HTML SSR plus Flight through the Rust-owned renderer; generated page entries now call the Web-stream SSR adapter and the build tests prove JSX-to-stream execution with an adapter fixture, but production React bundles are still a gate;
2. production React graph integration that turns the runtime-owned manifest artifacts into full Flight payloads, hydration assets and React-wired action invocation; page, route-handler and server-action bundles now have executable Rust-renderer contracts, generated page props, manifest-derived Flight metadata, server action IDs, client-reference IDs, route client-reference membership, executable bundle plans, canonical renderer request payloads and hydration chunk plans, and Aegis has verified initial hydrate-hook execution, same-origin route transitions including a nested dynamic route with query data, pending/error navigation boundaries and a browser-to-Rust server action call, but full React Flight wire semantics and full React hydration semantics are still gates;
3. website and public docs updated only after the implementation supports their claims.

No performance or production-readiness claim is accepted until the relevant gate has executable evidence.
