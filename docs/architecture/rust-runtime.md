# Rust-owned React architecture

Status: Rust-owned implementation in progress.

## Non-negotiable contract

ZapJS is a Rust framework with React UI. A separately launched JavaScript server does not satisfy this contract.

React remains real React JavaScript. Server rendering requires a JavaScript engine embedded and controlled by Rust, with an explicit set of host capabilities. Rust owns request admission, routing, I/O, resource limits, lifecycle, application functions, deployment and tooling.

A deployment contains static browser assets and Rust function artifacts under one application/project. It must not require users to operate an additional backend or Splice service. Splice is an internal Rust process protocol and lifecycle mechanism, particularly for isolation and development replacement; its presence does not establish deployment compatibility by itself.

## Current evidence and migration gates

Before replacing that working path, verify these boundaries with executable code:

1. Real React rendering in a Rust-owned engine, including asynchronous scheduling, streams, exceptions, memory/time limits and cancellation.
2. Rust-only TSX/module compilation and dependency resolution. Browser and server React variants must resolve separately; no ambient platform imports or globals may leak into artifacts.
3. React Server Component references, Flight, browser hydration/navigation and action identity must agree across one build. A static HTML demonstration is not evidence of those features.
4. Splice framing, concurrency, cancellation, terminal cleanup, worker failure, deadlines and backpressure must have bounded behavior.
5. Application APIs/functions execute Rust directly, with explicit request context, error handling and input/body limits.
6. Managed deployment uses a verified Rust function runtime. Prove the deployed process and artifact dependencies.
7. Development, production build, installation and verification execute through Rust-owned tooling. Dependency acquisition must retain version and integrity checks.
8. Port the website and its factual documentation only after the actual architecture supports the behaviors it advertises.

Performance choices require measurements of the complete path: cold start, warm render/request latency, memory, concurrency, throughput and cancellation. No embedded JavaScript engine or process protocol is declared the fastest without that evidence.

## Current implementation

The first Rust-only foundation crates are now present under `crates/`:

- `zap-runtime` owns the shared application manifest schema, graph validation, route parsing, trie lookup, request target planning and unsafe path rejection.
- `zap-splice` restores Splice as a bounded Rust transport with tested deadlines, cancellation, frame limits, crash cleanup and subprocess behavior.
- `zap-render` runs JavaScript bundles inside a Rust-owned QuickJS context with stream consumption, explicit host calls, output limits and CPU interruption.
- `zap-build` discovers the application graph, writes `.zap/manifest.json` and compiles TSX through Rust Rolldown/Oxc APIs for server IIFE and browser module targets.

These crates are foundation evidence only. The runtime crate now owns the manifest schema that the build crate emits, validates manifest references and plans requests against static assets, pages and route handlers. The build crate proves typed graph discovery, atomic manifest emission and graph module bundling, but the workspace does not yet prove full React Server Components, hydration/navigation, server-action execution, managed deployment or the landing site. The exact test and Fozzy evidence is recorded in [`../implementation.md`](../implementation.md).

## Splice history

The original Splice source is preserved in Git commit `c6b2491`. Its MessagePack framing and Rust worker boundary are relevant, but the implementation and documentation cannot be restored uncritically. The corrected implementation keeps the intended Rust boundary while testing its actual guarantees.
