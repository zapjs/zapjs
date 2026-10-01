# Zap native modules

Zap builds optional `native/Cargo.toml` application libraries into Node-API addons. Server code imports generated, typed exports from `zap:native`. Calls run inside the hosting function process. JavaScript-only applications require no Rust compiler.

The Rust application owns its `#[napi]` exports. napi-rs owns argument conversion and TypeScript declarations; ordinary records, arrays, optional fields, `Result`, `bigint`, and buffers cross the native boundary directly. The compiler rejects native imports in browser modules.

`zap-native` supplies bounded CPU scheduling and cooperative cancellation. Keep inexpensive synchronous exports small. For CPU work, export an async function and call `compute`, or own a `ComputePool` with an explicit capacity. Saturation rejects immediately; an abandoned operation retains its admission slot until its actual work ends. Check the cancellation token during long loops. Dropping a JavaScript promise does not cancel native work; expose an operation's cancellation method and connect the request's abort signal explicitly. Rust cannot forcibly stop arbitrary native code, and native memory faults share the Node process.

Request metadata is an explicit typed argument owned by the application. No ambient authentication object or public HTTP endpoint is created for an export. Use `BigInt` for integers requiring precision beyond JavaScript's safe integer range. Snapshot JavaScript-owned mutable buffers on the JavaScript thread before asynchronous execution; the fixture demonstrates `BufferSlice` with `AsyncBlockBuilder`.

Build inputs use napi `3.13.0` with `napi8`, `tokio_rt`, and `dyn-symbols`, napi-derive `3.6.9`, and napi-build `2.5.0`. Select `crate-type = ["cdylib"]` and call `napi_build::setup()` from `build.rs`. Rust 1.88+ is required. The helper crate is shipped as source with the framework at `@zap-js/client/native/rust/Cargo.toml`; it is not assumed published on crates.io.

Supported build targets are macOS arm64/x64 and Linux glibc arm64/x64. Native builds currently run on the target OS and architecture. Cross-target builds, musl, Windows, and edge isolates fail explicitly. Build Linux deployment artifacts in Linux; do not package a developer's macOS addon. Include `.zap/types/**/*.d.ts` in the application's TypeScript configuration. Release builds require a Cargo lockfile. Restart the development runtime after rebuilding an addon; a native library cannot be reliably unloaded with JavaScript module cache invalidation.

Verification from the repository root:

```sh
cargo test -p zap-native
node --import tsx --test packages/native/test.mjs
```

The Node test builds and loads an actual addon, checks Rust-generated declarations, typed values and errors, event-loop responsiveness, admission limits, cancellation, deadlines, and target rejection. These are correctness checks, not hosting certification or performance comparisons.
