# Application runtime

Status: target contract for the Rust-owned runtime.

Zap applications use one route graph rooted at `app/`. Pages, layouts, route handlers, server components, client components, server actions, assets and cache policy are compiled into one manifest. Development and production must use the same graph semantics.

## Request model

The runtime receives a platform-neutral request: method, URL, headers, body stream, request context, abort signal and deadline. Rust owns admission, routing, body limits, response headers and response byte streams. The managed host entrypoint is lowered directly into this contract.

Request context is explicit Rust-owned state. Client bundles stay on the browser side of the graph.

## Rendering

React runs inside an embedded JavaScript engine controlled by Rust. Server bundles receive only the Web primitives and named host operations ZapJS installs.

HTML SSR, React Server Components, Flight payloads, client references, action IDs and hydration inputs must come from the same build manifest. Page HTML and Flight server entries receive generated page props with dynamic `params`, array-valued decoded `searchParams`, normalized request headers, bounded UTF-8 request bodies, manifest-derived Flight metadata and the Rust request payload, include the React SSR adapter only for JSX page HTML entries, and expose a separate page Flight artifact with `ZapRender.flight(request)` for Flight payload requests. Page HTML emitted by `zap-execute` includes manifest-derived hydration metadata, modulepreload links for route browser chunks, page hydration bundles for JSX pages and the Rust-generated browser bootstrap module script; structured page Flight requests with `RSC: 1` or `Accept: text/x-component` run through the separate page Flight artifact. JSX pages use `react-server-dom-webpack/server.edge` under the `react-server` condition; non-JSX fallback Flight responses use the Zap envelope until they opt into an explicit `flight` hook. Streaming must preserve backpressure and abort propagation. Full buffering is allowed only at explicitly bounded capture points such as public prerendering.

## Route handlers and server actions

Route handlers and server actions must pass through Rust-owned admission before dispatch. Generated route-handler entries receive the canonical Rust request payload and call user handlers with a Web `Request` object that exposes `method`, `url`, `headers`, `text()`, `json()`, `arrayBuffer()`, `URL`, `URLSearchParams` and Zap route fields for `path`, `params` and decoded `searchParams`. The current runtime proves method, origin/action, malformed-origin, body-size, request-context, auth-state, deadline, public-cache privacy checks, cache-control header decisions and application authorization hooks before mutation paths execute. The generated browser action proxy posts to `/_zap/action`; `zap-execute` parses that payload and dispatches it through the same Rust action admission and renderer path. The browser bootstrap imports the manifest-owned action proxy, invokes the matched JSX page hydration bundle through React `hydrateRoot`, passes action/navigation context to client hydrate hooks, intercepts same-origin links, fetches the next Rust-rendered page through the same artifact executor, aborts superseded navigations, ignores stale responses, re-runs route hydration and exposes pending/error navigation boundary state through `data-zap-pending`, `data-zap-error`, `data-zap-navigation` and `zap:navigation-state` events. Aegis verification has proven a browser hydrate hook can call a server action through the Rust endpoint, that same-origin link transitions rehydrate the target route including a nested dynamic route with decoded query data, that a slow target route exposes pending state and that a failed target route exposes an error boundary message.

Application capabilities are Rust functions or explicit React-host operations. Errors that cross a public boundary must preserve useful diagnostics for operators without leaking private values to the browser; `zap serve` logs malformed HTTP input, oversized declared bodies, oversized request targets, oversized headers and artifact execution errors server-side, returns bounded 400 responses for malformed requests, bounded 413 responses before body allocation, bounded 414 responses for oversized request targets, bounded 431 responses for oversized headers and bounded 500 responses for execution failures.

## Caching

Public prerendering and shared cache metadata are build/runtime features, not process-memory assumptions. Request-local memoization is safe only within a single request. Cross-instance invalidation requires a host-managed store or Rust-owned persistence boundary with deployment-specific namespace/versioning.

Personalized responses must remain private. Public cache fills must reject request metadata and other private dependencies.

## Splice

Splice is an internal Rust worker boundary. The current version supports bounded unary calls, credit-based response streaming, negotiated frame limits, deadlines, cancellation, typed remote errors, capacity release and crash cleanup.

The framework owns any Splice worker lifecycle it chooses to use.

## Current limits

The current Rust crates prove foundation behavior and initial Rust request admission:

- route matching, manifest-backed request target planning, terminal HTTP response mapping, manifest source/bundle path and route/action source identity validation, route/action module-kind validation, client/server bundle boundary validation, static asset source-path validation, route-handler method admission, GET-to-HEAD route-handler admission, server-action admission, request id/auth/deadline policy admission, cache/privacy admission, cache-control header decisions, declared body-limit admission, bounded UTF-8 request-body delivery to renderer payloads and unsafe or ambiguous URL path rejection;
- bounded Splice unary and credit-based streaming transport behavior;
- embedded JavaScript execution with page HTML, page Flight, an explicit inert console and Web `MessageChannel` scheduling for React package compatibility, Web `Request`/`URL` route-handler and server-action entrypoints, route/action `Response` status/header validation, redirect/json helpers and body adaptation, typed route/action error-boundary outcomes, streams, explicit host calls, absence of ambient platform capabilities, output limits and CPU interruption;
- Rust artifact execution that loads the built manifest, admits requests/actions through `zap-runtime`, enforces execution context policy and application authorization hooks, serves static assets and manifest-owned browser assets, runs page HTML, page Flight through separate page Flight artifacts, route-handler and server-action bundles through `zap-render`, injects hydration metadata, page hydration chunks and the browser bootstrap module script into page HTML, invokes generated React page hydration bundles, passes the generated action proxy to hydrate hooks, handles same-origin client navigation with stale-response suppression, replaces target head/body content, exposes pending/error navigation boundaries and handles the generated `/_zap/action` endpoint;
- Rust-only TSX bundling for browser and server outputs, generated Web `Request`/`URL` route-handler adapters, manifest-owned browser action-proxy emission, including unsupported platform-module rejection, ambient platform-global rejection across direct, optional, literal and statically computed bracketed, probe and destructured references, static template module-specifier scanning, local type-only import/export elision, dependency-only helper/type module exclusion, non-static dynamic-import rejection and regex-literal/non-reference identifier false-positive protection;
- native `zap check`, `zap build`, `zap package`, `zap deploy --target local-package`, `zap deploy --target managed-native`, `zap deploy --target provider-fs` and `zap serve` commands, which validate the Rust application graph, drive the Rust build path that writes the runtime manifest, deployment manifest and bundles, materialize a package root from the Rust deployment manifest, lower build output into verified local, managed-native and provider filesystem deployment targets and serve built artifacts through the Rust executor with bounded public error responses.

The full runtime now proves current React package HTML SSR, page Flight streams, generated route layout composition, local client-reference Flight records and generated React `hydrateRoot` page hydration bundles through the Rust-owned build and serve path. Aegis verification has proven the browser receives the Flight model, hydrates page and layout client components through the Rust-generated page hydration bundle and processes real clicks without script errors. The remaining production gate is breadth: larger navigation/action matrices and provider package soak tests. The deployed process matrix now covers local-package, managed-native and provider-uploaded artifact roots, deployed cache-control policy headers, artifact-root 404/405 admission and server action endpoint success and denial paths in addition to successful page, Flight, route-handler, static asset and browser-asset serving.
