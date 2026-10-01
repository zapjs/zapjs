# Application runtime

Status: target contract for the Rust-owned runtime.

Zap applications use one route graph rooted at `app/`. Pages, layouts, route handlers, server components, client components, server actions, assets and cache policy are compiled into one manifest. Development and production must use the same graph semantics.

## Request model

The runtime receives a platform-neutral request: method, URL, headers, body stream, request context, abort signal and deadline. Rust owns admission, routing, body limits, response headers and response byte streams. Platform adapters translate a managed host invocation into this contract.

Request context is explicit Rust-owned state. Client bundles cannot import server runtime APIs.

## Rendering

React runs inside an embedded JavaScript engine controlled by Rust. Server bundles receive only the Web primitives and named host operations ZapJS installs. They do not receive filesystem, network or process APIs by default.

HTML SSR, React Server Components, Flight payloads, client references, action IDs and hydration inputs must come from the same build manifest. Streaming must preserve backpressure and abort propagation. Full buffering is allowed only at explicitly bounded capture points such as public prerendering.

## Route handlers and server actions

Route handlers and server actions execute through Rust-owned admission. Body limits, origin/action validation, request context, authorization hooks and typed errors are enforced before application code mutates state.

Application APIs are Rust functions or explicit React-host operations. Errors that cross a public boundary must preserve useful diagnostics for operators without leaking private values to the browser.

## Caching

Public prerendering and shared cache metadata are build/runtime features, not process-memory assumptions. Request-local memoization is safe only within a single request. Cross-instance invalidation requires an adapter-backed store with deployment-specific namespace/versioning.

Personalized responses must remain private. Public cache fills must reject request metadata and other private dependencies.

## Splice

Splice is an internal Rust worker boundary. The current version supports bounded unary calls, negotiated frame limits, deadlines, cancellation, typed remote errors and crash cleanup. It does not yet advertise streaming.

Normal application deployment must not require a user-operated Splice service. The framework owns any worker lifecycle it chooses to use.

## Current limits

The current Rust crates prove foundation behavior and initial Rust request admission:

- route matching, manifest-backed request target planning, terminal HTTP response mapping, static asset source-path validation, route-handler method admission, server-action admission, declared body-limit admission and unsafe path rejection;
- bounded Splice transport behavior;
- embedded JavaScript execution with page, route-handler and server-action entrypoints, route/action `Response` status/header/body adaptation, typed route/action error-boundary outcomes, streams, host calls, output limits and CPU interruption;
- Rust-only TSX bundling for browser and server outputs.

The full runtime still needs executable SSR/RSC/hydration/navigation integration, React action wiring and route-handler/action context/auth policy, managed native deployment verification and the developer workflow.
