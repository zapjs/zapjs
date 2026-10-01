# Application runtime

Status: target contract for the Rust-owned runtime.

Zap applications use one route graph rooted at `app/`. Pages, layouts, route handlers, server components, client components, server actions, assets and cache policy are compiled into one manifest. Development and production must use the same graph semantics.

## Request model

The runtime receives a platform-neutral request: method, URL, headers, body stream, request context, abort signal and deadline. Rust owns admission, routing, body limits, response headers and response byte streams. The managed host entrypoint is lowered directly into this contract.

Request context is explicit Rust-owned state. Client bundles stay on the browser side of the graph.

## Rendering

React runs inside an embedded JavaScript engine controlled by Rust. Server bundles receive only the Web primitives and named host operations ZapJS installs.

HTML SSR, React Server Components, Flight payloads, client references, action IDs and hydration inputs must come from the same build manifest. Streaming must preserve backpressure and abort propagation. Full buffering is allowed only at explicitly bounded capture points such as public prerendering.

## Route handlers and server actions

Route handlers and server actions must pass through Rust-owned admission before dispatch. The current runtime proves method, origin/action, malformed-origin, body-size, request-context, auth-state, deadline, public-cache privacy checks, cache-control header decisions and application authorization hooks before mutation paths execute. The generated browser action proxy posts to `/_zap/action`; `zap-execute` parses that payload and dispatches it through the same Rust action admission and renderer path.

Application capabilities are Rust functions or explicit React-host operations. Errors that cross a public boundary must preserve useful diagnostics for operators without leaking private values to the browser.

## Caching

Public prerendering and shared cache metadata are build/runtime features, not process-memory assumptions. Request-local memoization is safe only within a single request. Cross-instance invalidation requires a host-managed store or Rust-owned persistence boundary with deployment-specific namespace/versioning.

Personalized responses must remain private. Public cache fills must reject request metadata and other private dependencies.

## Splice

Splice is an internal Rust worker boundary. The current version supports bounded unary calls, negotiated frame limits, deadlines, cancellation, typed remote errors and crash cleanup. It does not yet advertise streaming.

The framework owns any Splice worker lifecycle it chooses to use.

## Current limits

The current Rust crates prove foundation behavior and initial Rust request admission:

- route matching, manifest-backed request target planning, terminal HTTP response mapping, manifest source/bundle path and route/action source identity validation, route/action module-kind validation, client/server bundle boundary validation, static asset source-path validation, route-handler method admission, GET-to-HEAD route-handler admission, server-action admission, request id/auth/deadline policy admission, cache/privacy admission, cache-control header decisions, declared body-limit admission and unsafe or ambiguous URL path rejection;
- bounded Splice transport behavior;
- embedded JavaScript execution with page, route-handler and server-action entrypoints, route/action `Response` status/header validation and body adaptation, typed route/action error-boundary outcomes, streams, explicit host calls, absence of ambient platform capabilities, output limits and CPU interruption;
- Rust artifact execution that loads the built manifest, admits requests/actions through `zap-runtime`, enforces execution context policy and application authorization hooks, serves static assets, runs page, route-handler and server-action bundles through `zap-render` and handles the generated `/_zap/action` endpoint;
- Rust-only TSX bundling for browser and server outputs, manifest-owned browser action-proxy emission, including unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection and regex-literal/non-reference identifier false-positive protection;
- native `zap check` and `zap build` commands, which validate the Rust application graph and drive the Rust build path that writes the runtime manifest and bundles.

The full runtime still needs full SSR/RSC/hydration/navigation integration, hydrated React action execution verified in-browser, managed native deployment verification and the remaining development/deploy workflow.
