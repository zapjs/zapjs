# Implementation evidence

Verified October 1, 2026 for the Rust-owned foundation. This page records what is currently proven and what remains open.

## Corrective Rust layer

| Crate | Evidence |
|---|---|
| `zap-runtime` | Owns the shared application manifest schema, validates graph references, parses route patterns, builds a compiled trie, resolves manifest-backed routes, plans request targets for static assets/pages/route handlers, maps terminal admission outcomes to HTTP response contracts, enforces page/asset/handler method policy, admits known server actions with POST and same-origin checks, rejects oversized declared request bodies before dispatch, validates static asset source paths at manifest load and source resolution and rejects malformed, unsafe or ambiguous URL paths. |
| `zap-splice` | Implements bounded Rust-to-Rust unary invocation over Unix streams with version handshake, negotiated frame size, max in-flight admission, typed remote errors, cancellation, deadlines, disconnect cleanup and a real same-binary subprocess fixture. |
| `zap-render` | Runs bundle-produced JavaScript in a Rust-owned QuickJS context with no process/filesystem/network APIs exposed by default. Tests cover string output, Web `ReadableStream` output, explicit Rust host calls, output limits and CPU interruption. |
| `zap-build` | Builds the runtime-owned application manifest, writes it atomically under `.zap/manifest.json`, emits page server bundles with the `ZapRender.render` contract, emits per-export server-action IDs, records exported route-handler methods, skips fake server bundles for client modules and bundles graph modules through Rust Rolldown/Oxc APIs. Tests cover route/layout/action-export/handler-method/client-module/asset/cache discovery, action-module and route-handler export validation, ambiguous route rejection, runtime manifest loading, page server-bundle execution through `zap-render`, browser module output and graph-to-artifact emission without invoking an external JavaScript runtime. |

## Commands run

```sh
CARGO_TARGET_DIR=artifacts/verification/rust-target cargo +1.96.0 test --workspace
```

Results:

- `zap-runtime`: 12 tests passed.
- `zap-splice`: 7 tests passed, 1 ignored subprocess helper invoked by the parent test.
- `zap-render`: 5 tests passed.
- `zap-build`: 7 tests passed.

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

1. real React HTML SSR and Flight through the Rust-owned renderer using production React bundles;
2. production React graph integration that turns the runtime-owned manifest artifacts into matching Flight payloads, client references, hydration assets and executable action invocation; page server bundles now have an executable Rust-renderer contract, server action IDs are per export and action admission is checked, but React SSR and action execution are still gates;
3. Aegis verification for initial render, hydration, nested/dynamic navigation, pending/error boundaries and server actions;
4. executable Rust route-handler/server-function invocation with explicit input, context, authorization and error boundaries; route-handler method admission, action admission, terminal HTTP response mapping and declared body-limit admission are now manifest-backed/runtime-backed, but handler/action execution is still a gate;
5. optional Splice streaming with credit-based backpressure if a worker boundary needs streaming;
6. direct native managed-deployment artifacts from the Rust build path;
7. Rust-owned development, build, test and deploy commands;
8. website and public docs updated only after the implementation supports their claims.

No performance or production-readiness claim is accepted until the relevant gate has executable evidence.
