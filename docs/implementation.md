# Implementation evidence

Verified October 1, 2026 for the Rust-owned foundation. This page records what is currently proven and what remains open.

## Corrective Rust layer

| Crate | Evidence |
|---|---|
| `zap-runtime` | Owns the shared application manifest schema, validates graph references, parses route patterns, builds a compiled trie, resolves manifest-backed routes, plans request targets for static assets/pages/route handlers, maps terminal admission outcomes to HTTP response contracts, enforces page/asset/handler method policy including executable page bundle planning and canonical renderer request payloads, runtime GET-to-HEAD route-handler admission, executable route-handler bundle planning and canonical renderer request payloads, admits known server actions with POST, same-origin checks, malformed-origin rejection, executable action bundle planning and canonical action invocation payloads, enforces request id/auth/deadline execution policy before dispatch, rejects public cache fills that touched private request state before dispatch, validates route cache policies, maps route cache decisions to cache-control headers, rejects oversized declared request bodies before dispatch, validates manifest source/bundle paths, enforces route/action/client-reference source identity, validates route-scoped client-reference membership and exposes route hydration plans, enforces route/action/client-reference module-kind boundaries, rejects unsupported route-handler methods, rejects client modules that declare server bundles, validates client-reference browser chunk identity, validates static asset source paths at manifest load and source resolution and rejects malformed, unsafe or ambiguous URL paths. |
| `zap-splice` | Implements bounded Rust-to-Rust unary invocation over Unix streams with version handshake, negotiated frame size, max in-flight admission, typed remote errors, cancellation, deadlines, disconnect cleanup and a real same-binary subprocess fixture. |
| `zap-render` | Runs bundle-produced JavaScript in a Rust-owned QuickJS context with only the installed Web primitives and explicit Rust host calls exposed by default. Tests cover page text output, page Web `ReadableStream` output, route-handler text output, server-action `Response` output, route/action error-boundary outcomes, route/action `Response` status/header validation and body adaptation, explicit Rust host calls, absence of ambient platform capabilities, output limits and CPU interruption. |
| `zap-cli` | Provides native `zap check` and `zap build` commands over the Rust graph/build path with explicit root/app/public/output/minification options. Tests cover parser behavior, graph validation without artifact writes, invalid graph rejection and a real minimal app build that writes `.zap/manifest.json` plus a server bundle. |
| `zap-build` | Builds the runtime-owned application manifest, writes it atomically under `.zap/manifest.json`, emits page server bundles with the `ZapRender.render` contract and a generated React SSR adapter that converts page render trees with `react-dom/server.browser` `renderToReadableStream`, emits route-handler server bundles with the `ZapRoute.handle` contract and server-action bundles with the `ZapAction.invoke` contract, emits per-callable-export server-action IDs, emits per-export client-reference IDs with browser chunk identity, records route-scoped client references and hydration chunk inputs from static page/layout imports, records callable route-handler methods with GET-to-HEAD derivation, does not emit server bundles for client-only modules and bundles graph modules through Rust Rolldown/Oxc crates. Tests cover route/layout/action-export/handler-method/client-module/client-reference/route-client-reference/hydration-plan/asset/cache discovery, strict cache export and policy validation, duplicate graph module ID rejection, action-module, server-action identity, typed callable export discovery for actions and route handlers plus named/default/aliased client-reference export discovery and typed local named export-list cache metadata discovery, re-export list exclusion until explicit graph resolution exists and callable route-handler export validation, GET-to-HEAD route-handler method derivation, generated GET fallback for HEAD route-handler bundles, ambiguous route rejection, runtime manifest loading, JSX page rendering through the generated SSR adapter and `zap-render`, route-handler and server-action bundle execution through `zap-render` using runtime-generated renderer/action payloads, browser module output, unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection, regex-literal and non-reference identifier false-positive protection and graph-to-artifact emission without invoking an external JavaScript runtime. |

## Commands run

```sh
CARGO_TARGET_DIR=artifacts/verification/rust-target cargo +1.96.0 test --workspace
```

Results:

- `zap-runtime`: 15 tests passed.
- `zap-splice`: 7 tests passed, 1 ignored subprocess helper invoked by the parent test.
- `zap-render`: 11 tests passed.
- `zap-build`: 14 tests passed.
- `zap-cli`: 11 tests passed.

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
2. production React graph integration that turns the runtime-owned manifest artifacts into matching Flight payloads, hydration assets and executable action invocation; page, route-handler and server-action bundles now have executable Rust-renderer contracts for text/stream/Response output, server action IDs, client-reference IDs, route client-reference membership, page executable bundle plans, canonical renderer request payloads and hydration chunk plans are manifest-validated, and action admission is checked, but Flight payload emission, browser-side hydration execution and React action wiring are still gates;
3. Aegis verification for initial render, hydration, nested/dynamic navigation, pending/error boundaries and server actions;
4. full Rust route-handler/server-action invocation with application-specific authorization hooks; route-handler method admission, GET-to-HEAD route-handler admission, request id/auth/deadline policy admission, cache/privacy admission, cache policy validation, cache-control header decisions, page bundle planning, canonical renderer request payloads, route-handler bundle planning plus initial text/stream/Response execution with response metadata validation, server-action bundle planning plus initial Response execution with response metadata validation, route/action error-boundary outcomes, action admission, terminal HTTP response mapping and declared body-limit admission are now manifest-backed/runtime-backed, but full handler/action execution is still a gate;
5. optional Splice streaming with credit-based backpressure if a worker boundary needs streaming;
6. direct native managed-deployment artifacts from the Rust build path;
7. the remaining Rust-owned development and deploy commands; `zap check` and `zap build` are now present;
8. website and public docs updated only after the implementation supports their claims.

No performance or production-readiness claim is accepted until the relevant gate has executable evidence.
