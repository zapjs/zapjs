# September 30, 2026 final safe transport results

The final renderer completed **6,400 measured warm requests with zero errors** across both framework orders. Each workload used 200 requests at concurrency 1 and 16 after ten warm-ups. Each framework also had three fresh-process trials in each order. These measurements validate the exercised responses under load; **they do not establish a stable performance comparison or isolate the transport's speed improvement**.

The Apple M3 Pro host (11 logical CPUs, 18 GiB RAM, macOS 24.3.0, Node 22.15.1) was heavily contended by unrelated Rust and TypeScript jobs. The first run's one-minute load average rose from 28.1 to 34.0; the reverse run moved from 33.2 to 23.8 as competing work subsided. Zap ran last in the reverse order and benefited disproportionately from the quieter period. Neither CPU nor memory was isolated. The frameworks remain pinned to Next 16.3.8 and React 19.3.0, with Zap's final uncommitted 0.3.0 implementation.

| Metric | Zap, first order | Zap, reverse order | Next, first order | Next, reverse order |
| --- | ---: | ---: | ---: | ---: |
| Dynamic HTML c1 median, ms | 6.28 | 0.80 | 14.78 | 9.41 |
| Dynamic HTML c1 p99, ms | 239.73 | 3.44 | 289.03 | 71.02 |
| Dynamic HTML c16 requests/s | 62.5 | 1,175.9 | 20.0 | 130.9 |
| Dynamic HTML c16 p99, ms | 588.90 | 30.45 | 1,954.24 | 300.07 |
| JSON echo c16 requests/s | 199.2 | 3,725.7 | 83.8 | 187.6 |
| JavaScript CPU c16 requests/s | 75.9 | 500.7 | 46.0 | 118.0 |
| Streamed 60 ms child c16 requests/s | 61.5 | 234.0 | 37.7 | 229.7 |
| Process start + first page median, ms | 2,119 | 202 | 3,190 | 1,737 |

The fresh-output build took **9.505 s for Zap** and **84.087 s for Next** while the host was contended. This single observation excludes dependency installation and deployment tracing and should not be interpreted as an intrinsic build-speed ratio. Total emitted client JavaScript was **251,650 bytes in 3 files for Zap** and **566,679 bytes in 10 files for Next**. These are raw bytes across the whole fixture, **not initial browser transfer bytes**. Local process starts are **not managed-platform cold starts**.

Raw final results are `artifacts/verification/benchmark-safe.json` (22:19 UTC) and `artifacts/verification/benchmark-safe-reverse.json` (22:21 UTC). Both use the same built artifacts and differ only in measurement order. Their recorded distributions, resource samples, request counts, and host load make the interference visible. Reproduce using the commands in [README.md](README.md); a dedicated host is required before setting budgets or claiming a comparative advantage.

## Historical initial baseline

This section records the initial renderer before the HTML/Flight transport replacement. It is retained for comparison; it does not describe the final implementation's timings.

Two runs, in opposite framework order, completed **6,400 measured warm requests with zero errors**. Each workload used 200 requests at concurrency 1 and 16 after ten warm-ups. Each framework also had three fresh-process trials per run. The applications used the same React 19.3.0 components and API code. Next.js was pinned to 16.3.8; Zap was the uncommitted 0.3.0 implementation in this repository.

These are framework-core measurements on one shared development machine, not a feature-parity comparison or a production performance guarantee. See [methodology](README.md) and the reproduction commands there.

Host: Apple M3 Pro, 11 logical CPUs, 18 GiB RAM, macOS kernel 24.3.0, arm64, Node 22.15.1. The one-minute load average was approximately 4.3–4.8. The reverse run's first cold trials briefly overlapped another small Vite build. Processes were sequential and separate, but CPU cores, thermals, and filesystem cache were not isolated.

## Measurements

Fresh-output build wall time was **924 ms for Zap** and **6,506 ms for Next**. This is one build measurement per framework, excludes dependency installation and deployment tracing, and benefits from the existing filesystem/dependency cache.

Total emitted client JavaScript for the whole fixture was **251,231 bytes in 3 files for Zap** and **566,679 bytes in 10 files for Next**. These are raw output bytes, **not initial browser transfer size**. Hydration, navigation, compression, and unused chunks were not measured by this comparison.

At concurrency 1, dynamic HTML full-response median latency was **1.72–1.80 ms for Zap** versus **1.22–1.32 ms for Next**. Next was faster for this metric in both runs.

At concurrency 16, the ranges across both runs were:

| Workload | Zap requests/s | Next requests/s | Zap p99 completion | Next p99 completion |
| --- | ---: | ---: | ---: | ---: |
| JSON echo | 4,483–5,090 | 1,915–2,348 | 10.51–10.73 ms | 34.87–48.87 ms |
| Fixed JavaScript CPU work | 874–1,503 | 1,215–1,251 | 25.21–28.08 ms | 51.02–54.71 ms |
| Dynamic RSC HTML | 2,226–2,269 | 1,006–1,032 | 12.94–13.90 ms | 21.96–24.59 ms |
| RSC HTML with 60 ms delayed child | 235–237 | 242–244 | 75.31–77.88 ms | 86.56–92.16 ms |

The CPU workload's throughput varied substantially across ordering; it does not support a reliable winner. Streaming completion throughput was close and dominated by the intentional 60 ms delay. Dynamic HTML and echo throughput favored Zap in these local samples, while single-request HTML latency favored Next.

Zap's median process-start-plus-first-page completion was approximately 141–144 ms across the two runs; Next's was approximately 308–418 ms. These are local process starts from existing build files, **not serverless cold starts**. Only six trials per framework were taken.

## Transport investigation

The initial HTML renderer used `rsc-html-stream@0.0.8`. Its HTML injection transform schedules its first flush with `setTimeout(..., 0)` before it starts forwarding Flight payloads. A scheduler-only experiment changed this to `setImmediate` in a temporary copy of the dependency. On the same concurrency-one fixture, median completion moved from 2.13 ms to 0.81 ms across two contended runs. This supports investigating the timer but is not a controlled attribution of the entire difference.

The experiment rejected the scheduler substitution: **both versions** inserted scripts inside attributes split across event-loop turns, lost binary prefixes across UTF-8 decoding failures, threw `RangeError` on a 256 KiB binary chunk, drained all 128 Flight chunks while output consumption paused, and failed to cancel a Flight reader already waiting for data. Batching was a heuristic, not an HTML correctness guarantee. Reproduce these observations with `node benchmarks/transport.mjs`.

The replacement retains React rendering and Flight decoding. It uses `parse5-sax-parser` to identify complete HTML tokens and places transport scripts only directly inside document head/body; it independently preserves each Flight chunk as text or base64 bytes. Output demand drives input reads, cancellation reaches both producers, and a total 8 MiB Flight limit applies before teeing into rendering and hydration. A separate 8 MiB limit bounds HTML awaiting a safe insertion point. Focused tests cover bytewise and 100 seeded random chunkings, executable script placement, binary integrity, delayed streaming, cancellation, and resource limits.

Raw results: `artifacts/verification/benchmark-local.json` and `artifacts/verification/benchmark-reverse.json` (ignored verification artifacts). Measurements were captured at 21:47 and 21:49 UTC. The harness records host details, settings, Git state, per-workload distributions, error counts, process CPU deltas, and sampled RSS. Tail percentiles from 200 requests are preliminary. Repeat on dedicated hardware and equivalent deployed runtimes before setting budgets or making comparative product claims.
