# Combined native fixture

This fixture adds `/native`, `/api/native`, and `/api/bytes` to the fullstack React fixture. Its Cargo manifest uses the Rust SDK shipped in the installed framework package. The checked-in Cargo lock fixes Rust dependency versions. Rust export source is shared with `packages/native/fixtures/addon/native`; the preparation script copies it directly.

After building the framework, prepare a source deployment with:

```sh
node scripts/build.mjs
node tests/production/prepare-cloud.mjs
```

The default output is `artifacts/verification/combined-cloud`. To regenerate an existing fixture after another framework build:

```sh
node tests/production/prepare-cloud.mjs artifacts/verification/combined-cloud --replace
```

The script reuses `zap new --native` for managed Rust installation and build configuration, packs the already-built framework without running lifecycle scripts, installs the local tarball, and checks the portable Rust dependency graph. No registry publish or cloud deployment occurs. Rust 1.92.0 is pinned; Rustup installs it locally on first use if needed. An equivalent preinstalled toolchain can be selected with `RUSTUP_TOOLCHAIN` for local preparation.

Deploy the generated source directory using Vercel CLI, without `--prebuilt`. Run `node tests/production/hosted.mjs URL` and `node tests/production/native-hosted.mjs URL` against the deployment. Browser verification uses Aegis.
