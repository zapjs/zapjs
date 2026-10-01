# Application runtime

Status: target contract for the Rust-owned runtime.

Zap applications use one route graph rooted at `app/`. Pages, layouts, route handlers, server components, client components, server actions, assets and cache policy are compiled into one manifest. Development and production must use the same graph semantics.

## Request model

The runtime receives a platform-neutral request: method, URL, headers, body stream, request context, abort signal and deadline. Rust owns admission, routing, body limits, response headers and response byte streams. The managed host entrypoint is lowered directly into this contract.

Request context is explicit Rust-owned state. Client bundles stay on the browser side of the graph.

## Rendering

React runs inside an embedded JavaScript engine controlled by Rust. Server bundles receive only the Web primitives and named host operations ZapJS installs.

HTML SSR, React Server Components, Flight payloads, client references, action IDs and hydration inputs must come from the same build manifest. Page HTML emitted by `zap-execute` now includes manifest-derived hydration metadata, modulepreload links for route browser chunks and the Rust-generated browser bootstrap module script. Streaming must preserve backpressure and abort propagation. Full buffering is allowed only at explicitly bounded capture points such as public prerendering.

## Route handlers and server actions

Route handlers and server actions must pass through Rust-owned admission before dispatch. The current runtime proves method, origin/action, malformed-origin, body-size, request-context, auth-state, deadline, public-cache privacy checks, cache-control header decisions and application authorization hooks before mutation paths execute. The generated browser action proxy posts to `/_zap/action`; `zap-execute` parses that payload and dispatches it through the same Rust action admission and renderer path. The browser bootstrap imports the manifest-owned action proxy, passes it to client hydrate hooks, intercepts same-origin links, fetches the next Rust-rendered page through the same artifact executor, re-runs route hydration and exposes pending/error navigation boundary state through `data-zap-pending`, `data-zap-error`, `data-zap-navigation` and `zap:navigation-state` events. Aegis verification has proven a browser hydrate hook can call a server action through the Rust endpoint, that a same-origin link transition rehydrates the target route, that a slow target route exposes pending state and that a failed target route exposes an error boundary message.

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
- Rust artifact execution that loads the built manifest, admits requests/actions through `zap-runtime`, enforces execution context policy and application authorization hooks, serves static assets and manifest-owned browser assets, runs page, route-handler and server-action bundles through `zap-render`, injects hydration metadata and the browser bootstrap module script into page HTML, passes the generated action proxy to hydrate hooks, handles same-origin client navigation, exposes pending/error navigation boundaries and handles the generated `/_zap/action` endpoint;
- Rust-only TSX bundling for browser and server outputs, manifest-owned browser action-proxy emission, including unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection and regex-literal/non-reference identifier false-positive protection;
- native `zap check`, `zap build` and `zap serve` commands, which validate the Rust application graph, drive the Rust build path that writes the runtime manifest, deployment manifest and bundles and serve built artifacts through the Rust executor.

The full runtime still needs full SSR/RSC/hydration semantics, target-platform native deployment packaging, deployed-process verification and the remaining deploy workflow.
