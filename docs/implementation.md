# Framework implementation and verification

Verified September 30, 2026. The integrated framework replaces the former HTTP/Splice process architecture. Version 0.3.0 remains unpublished; use the source tree or a local package tarball.

## Managed application proof

[Combined validation application](https://zapjs-combined-check-20260930.vercel.app) combines React server/client components, nested navigation, actions, public prerendering, streaming routes, and Rust functions in one deployment. Vercel built its native addon on Linux x64 with Rust 1.92.0. Deployment `dpl_C3B7XDyrWa6ywrzQmqFLZTqHCuny` runs the compiled application in Node 22.

This is an isolated validation project. Its first deployment was assigned Vercel's production target automatically; it did not replace an existing application. Earlier separate JavaScript and native validation projects are not the sole integration evidence.

Reproduce the application from checked-in sources:

```sh
bun run build
node tests/production/prepare-cloud.mjs artifacts/verification/combined-cloud
# From that generated directory, deploy the source with your Vercel project/scope.
# Do not deploy a macOS native binary with --prebuilt.
node tests/production/hosted.mjs https://your-deployment.example
node tests/production/native-hosted.mjs https://your-deployment.example
node tests/production/browser.mjs https://your-deployment.example
```

The preparation script records the packed framework's integrity and never publishes a package. Use `--replace` only to regenerate a previously marked verification directory. Aegis must be running at the profile/address configured by the browser script.

## Evidence

| Contract | Result and reproducer |
|---|---|
| Route and module graph | Conflict rejection, nested/group/dynamic/catchall routes, safe parameter decoding, prototype-safe records and trie precedence. Compiler/routing tests include overlapping graphs and 10,000-route lookup behavior. |
| React and browser | Aegis passed 14 checks on local production output and the combined hosted app: streamed content, hydration, nested navigation, dynamic state reset, history, persistent layouts, actions, HttpOnly cookies, error boundaries and recovery. The fixture's browser probe operates DOM controls; Aegis CLI navigates and inspects its results. |
| Mutations and deployment skew | Actual builds reject old hydrated requests and unhydrated plain/bound forms before mutation. Current forms execute after source deletion. Thrown strings/objects are redacted with opaque error IDs. `tests/production/skew.mjs`. |
| Request and cache isolation | Concurrent request isolation, mutation-only cookies, request memoization, real Redis cross-instance invalidation, stale-fill rejection, expiry and falsy JSON values. No process-memory shared-cache substitute. |
| Prerender safety | Actual builds reject cross-route publication, request metadata, late Suspense errors and oversized Flight. `tests/production/prerender.mjs`. Hosted static HTML produced an observed CDN HIT. |
| Streaming | Adversarial split HTML, raw text, binary/UTF-8/BOM preservation, 100 seeded chunkings, bounded reads and peer cancellation. Real HTTP adapter tests cover socket backpressure and disconnect abort. Hosted observations received `first` about 104–135 ms before `last` in three trials. This is delivery evidence, not a latency guarantee. |
| Managed packaging | Source-free relocated traced function executes React and handlers. The combined hosted app passes API, binary, repeated cookie, origin and error checks. `framework.mjs`, `hosted.mjs`. |
| Native execution | Real addon signatures, objects, Buffer, BigInt, errors, nonblocking bounded work, deadline/cancellation, panic handling and shared-scope reuse. Relocated native output works after source deletion; the Linux hosted app passes Rust SSR/Flight/API checks. |
| Development | Actual React source/route updates; generated native app rebuilds, reports compile errors, recovers, and terminates its Cargo descendants during shutdown. `dev.mjs`, `native-dev.mjs`. |
| Distribution | Isolated npm tarball install, generated app typecheck/build/source-free preview, native SDK inclusion and retired CLI rejection. JavaScript-only builds are tested with Rust tools deliberately unavailable. `package.mjs`. |
| Cleanup | Removed obsolete HTTP server, Splice/IPC chain, generated RPC clients, platform binaries, templates, tests, container scripts and contradictory docs. Removed fabricated benchmark output and unused CLI spinner machinery. |
| Performance | Equivalent pinned Next.js comparison is reproducible in `benchmarks/compare.mjs`; measured results and host contention are recorded in `benchmarks/RESULTS.md`. No universal speedup or maximum-performance claim. |

The aggregate `node scripts/verify.mjs` passed: 48 framework tests, 3 Rust tests, 5 real-addon Node tests, and all production/development/package scripts. The host-backed Fozzy run took 388.269 seconds under contention, run ID `4fbc80d3-9b9e-4161-8553-30c45be4224d`. Its actual trace is `artifacts/verification/final.1.fozzy`; strict trace verification, replay and CI all passed. Raw stdout/stderr are retained in the run's `events.json`.

After removing unused CLI logger methods and the `ora` dependency, a fresh framework build and isolated package verification passed again in 20.353 seconds, run `ed86dce2-ecdc-46a1-b288-8be55febdee7`. Its `package-final.fozzy` trace also passed strict verification, replay and CI. A byte comparison against the hosted package confirmed that only the CLI logger JavaScript/declarations changed; rendering, compilation, adapters and native SDK stayed identical to the hosted verification snapshot.

Local artifacts under ignored `artifacts/verification` include `final-host.json`, `final-trace-verify.json`, `final-replay.json`, `final-ci.json`, `combined-hosted.json`, `combined-native-hosted.json`, and `combined-browser.json`. Checked-in scripts reproduce them; these local artifact files are not distributed as source.

## Testing limitations

The installed `fozzy` executable reports version 0.1.0, commit `c6b249191dd4`, and exposes an `fz`-labelled help surface. We invoked `fozzy`, not the separate `fz` command. It rejects `test --strict` in favor of `--strict-verify`. Strict doctor/test and fuzz/explore reject undeclared real subprocesses even with host flags. Their recorded failures are harness limitations, not passing application tests. Adding canned `proc_when` success responses would hide the application execution and was deliberately avoided.

The actual recorded run explicitly uses host process/filesystem/HTTP backends. Trace verification and replay establish that recorded scenario's outcome; they do not establish deterministic scheduling inside Node, Redis or a managed platform. Fuzz/explore did not supply application-level coverage on this installed runtime. Focused seeded transport/route tests supply their stated coverage separately.

## Supported scope and remaining product work

The deployed core matches the intended application model: one React application, static/CDN output, managed dynamic invocation and optional native code inside that invocation. There is no separately provisioned Zap backend or production process supervisor.

The initial target is Vercel Node 22, with one dynamic function and lazy route chunks. Native builds support matching Linux GNU x64/arm64 deployment and macOS/Linux development; Edge/WASM and cross-compilation are explicitly rejected. Function partitioning and other hosting adapters are future work. Strict nonce-based CSP/SRI, image optimization, middleware conventions, parallel/intercepting routes and full Next.js API compatibility are not claimed.

Application authors must authorize their operations, configure deployment-specific shared-cache namespaces and keep shared loaders independent of private values. Native cancellation is cooperative; native faults share the function process. Bodies are limited to 1 MiB; HTML hydration/prerender Flight and pending HTML have explicit 8 MiB limits. See [runtime contracts](runtime.md).

Dedicated-host performance budgets, matched managed Next.js cold-start comparisons, database-backed workloads, browser transfer/paint timings and production-scale soak tests remain future measurement work. The current results support this architecture and its tested behavior, not a blanket claim that every application is production-ready or faster than Next.js.
