# Architecture migration — September 30, 2026

ZapJS now builds one integrated React application into static assets and managed function output. React Server Components, streaming HTML, hydration, navigation, server actions, public prerendering and request/cache isolation use one compiler graph. Optional Rust functions run through in-process Node-API bindings.

The old Rust HTTP server, Splice supervisor, sockets, RPC clients, binary platform packages and their obsolete templates/tests/docs have been removed. No separate backend service is required.

The combined React/native application was built on Linux and verified on Vercel, including browser interaction through Aegis. The aggregate host-backed verification passed and its Fozzy trace passed verification, replay and CI. This package has not been published.

See [implementation evidence and limitations](docs/implementation.md), [runtime contracts](docs/runtime.md), [architecture](docs/architecture/framework.md), and [measured performance](benchmarks/RESULTS.md). The initial managed target is Vercel Node 22; broader hosting, feature parity and production-scale performance claims remain outside the tested scope.
