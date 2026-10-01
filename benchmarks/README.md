# Local framework comparison

`compare.mjs` builds matching applications with ZapJS and Next.js **16.3.8**, using React **19.3.0**. The Next version and engine requirement were checked against npm on September 30, 2026. Neither fixture uses native Rust code.

```sh
npm run build --workspace @zap-js/client
node benchmarks/compare.mjs --build-only
node benchmarks/compare.mjs --skip-build --requests 200 --cold-runs 3
# Repeat in reverse order to expose ordering and machine-load effects:
node benchmarks/compare.mjs --skip-build --requests 200 --cold-runs 3 \
  --order next,zap --output artifacts/verification/benchmark-reverse.json
```

Fixtures, dependency installs, compiler logs, and runtime logs live under `.zap/benchmarks`. Results default to `artifacts/verification/benchmark-local.json`. These directories are ignored build/verification artifacts. A full build deletes previous framework outputs before measuring build wall time; dependency installation is excluded. `--skip-build` reuses recorded build timings and must follow a matching build.

The two applications share the same layout, interactive counter, dynamic server page, streamed Suspense page with a 60 ms delayed child, JSON echo handler, and fixed 250,000-iteration JavaScript checksum. The runner verifies expected output for every measured response. Zap's compiled Web handler runs through its Node preview adapter; Next runs its production `next start` entrypoint. Each server runs in its own process, one framework at a time, with `NODE_ENV=production`.

Recorded metrics:

- Build wall time after output cleanup, excluding dependency installation.
- Total emitted client JavaScript files and uncompressed bytes for the whole fixture; this is **not** measured browser transfer size.
- Fresh-process startup readiness and the first dynamic-page request over three trials; this is **not** a managed-platform cold start.
- Warm request first-byte and full-response p50/p95/p99, throughput, response bytes, and errors at concurrency 1 and 16, after ten warm-up requests per workload.
- Process CPU time differences and RSS sampled before/after each workload using `ps`; sampled RSS is **not** peak memory.
- Machine CPU, memory, operating system, Node/V8 versions, Git state, fixture hash, and host load averages.

Requests use `Accept-Encoding: identity` to avoid comparing one server's HTTP compression against another platform's compression. The driver and server share the same unpinned machine. Browser hydration/navigation, CDN/static hits, database latency, native acceleration, distributed cache behavior, managed runtime scheduling, and complete Next feature parity are outside this comparison. The build excludes deployment tracing for both frameworks. Machine load, thermal state, filesystem cache, framework measurement order, and a small tail-latency sample can materially affect results.

Report results as measurements of these fixtures on the stated host. There is no performance acceptance threshold and no claim of universal superiority. Repeated measurements on dedicated hardware and equivalent hosted deployments are required before setting production performance budgets.

## Hydration transport investigation

`node benchmarks/transport.mjs` creates a temporary, MIT-attributed copy of the pinned upstream injector with only its scheduler changed from `setTimeout` to `setImmediate`. It records adversarial audit observations under `artifacts/verification/transport-audit.json`. `--benchmark` also runs the same concurrency-one fixtures before/after changing only the generated benchmark SSR import, then restores that generated file. It never edits a package dependency or framework source. Run it only against an existing benchmark build which still imports the upstream transport; current safe transport builds intentionally fail that guard.

This scheduler-only candidate is rejected. Both versions corrupt HTML attributes split across event-loop turns, lose binary UTF-8 prefixes, throw on large binary chunks, drain producers while consumers pause, and leave a pending Flight reader uncancelled. The production replacement uses maintained HTML tokenization and explicit resource limits; its focused regressions are `packages/client/src/framework/stream.test.ts`. The benchmark experiment remains to reproduce the original defects and establish why a scheduler substitution alone was insufficient.
