# Build Pipeline

This document details the Zap.js build system, covering both development and production pipelines.

## Overview

Zap.js has two build modes:
- **Development**: Hot reload, fast iteration
- **Production**: Optimized, single binary deployment

## Development Pipeline

### Entry Point

```bash
zap dev
```

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               zap dev                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Initialize DevServer                                                    │
│     └── Load zap.config.ts                                                  │
│     └── Detect binary paths                                                 │
│                                                                             │
│  2. Rust Compilation (RustBuilder)                                          │
│     └── cargo build --release --message-format=json                         │
│     └── Parse compiler output for errors                                    │
│     └── Output: target/release/zap                                          │
│                                                                             │
│  3. TypeScript Codegen (CodegenRunner)                                      │
│     └── zap-codegen --project-dir . --output-dir ./src/generated            │
│     └── Output: server.ts, backend.ts, backend.d.ts                         │
│                                                                             │
│  4. Route Scanning (RouteScannerRunner)                                     │
│     └── Scan routes/ directory                                              │
│     └── Output: routeTree.ts, routeManifest.json                           │
│                                                                             │
│  5. Start Vite Dev Server (ViteProxy)                                       │
│     └── npx vite --port 5173                                                │
│     └── Proxy /api/* to Rust server                                         │
│                                                                             │
│  6. Start Hot Reload Server (HotReloadServer)                               │
│     └── WebSocket server on :3001                                           │
│     └── Broadcast reload signals                                            │
│                                                                             │
│  7. Spawn Rust Binary (ProcessManager)                                      │
│     └── ./target/release/zap --config /tmp/zap-config.json                  │
│     └── IPC socket at /tmp/zap-{pid}.sock                                   │
│                                                                             │
│  8. Start File Watcher (FileWatcher)                                        │
│     └── Watch: src/, routes/, server/                                       │
│     └── Triggers: rebuild, codegen, route scan                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

#### RustBuilder

```typescript
class RustBuilder {
  async build(): Promise<string> {
    // Run cargo build with JSON output
    const proc = spawn('cargo', [
      'build',
      '--release',
      '--message-format=json',
    ]);

    // Parse compiler messages
    for await (const line of proc.stdout) {
      const msg = JSON.parse(line);
      if (msg.reason === 'compiler-message') {
        this.emit('message', msg.message);
      }
    }

    return this.getBinaryPath();
  }
}
```

#### CodegenRunner

```typescript
class CodegenRunner {
  async run(): Promise<void> {
    await exec([
      this.binaryPath,
      '--project-dir', this.projectDir,
      '--output-dir', this.outputDir,
      '--server',      // Generate namespaced client
      '--runtime',     // Generate runtime bindings
      '--definitions', // Generate .d.ts
    ]);
  }
}
```

#### RouteScannerRunner

```typescript
class RouteScannerRunner {
  async scan(): Promise<ScannedRoute[]> {
    const scanner = new RouteScanner({
      routesDir: this.routesDir,
      extensions: ['.tsx', '.ts'],
    });

    const routes = await scanner.scan();

    // Generate route tree
    await generateRouteTree({
      routesDir: this.routesDir,
      outputDir: this.outputDir,
    });

    return routes;
  }
}
```

### Watch Mode

```
File Changed
    │
    ▼
┌─────────────────────────────────────────────┐
│            FileWatcher (chokidar)           │
└─────────────────────────────────────────────┘
    │
    ├── *.rs file
    │   └── RustBuilder.build()
    │       └── CodegenRunner.run()
    │           └── HotReloadServer.reload('rust')
    │
    ├── routes/**/*.ts
    │   └── RouteScannerRunner.scan()
    │       └── HotReloadServer.reload('routes')
    │
    └── src/**/*.tsx
        └── Vite HMR (automatic)
```

## Production Pipeline

### Entry Point

```bash
zap build
```

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              zap build                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Clean Output Directory                                                  │
│     └── rm -rf ./dist                                                       │
│     └── mkdir -p ./dist/{bin,static}                                        │
│                                                                             │
│  2. Build Rust Binary                                                       │
│     └── cargo build --release                                               │
│     └── Profile: LTO=fat, codegen-units=1, panic=abort                      │
│     └── Copy to: dist/bin/zap                                               │
│                                                                             │
│  3. Build Frontend (Vite)                                                   │
│     └── npx vite build                                                      │
│     └── Output: dist/static/                                                │
│                                                                             │
│  4. Run Codegen                                                             │
│     └── zap-codegen --output ./src/generated                                │
│                                                                             │
│  5. Generate Route Manifest                                                 │
│     └── Scan routes/ directory                                              │
│     └── Write routeManifest.json                                            │
│                                                                             │
│  6. Create Server Config                                                    │
│     └── Write dist/config.json                                              │
│                                                                             │
│  7. Create Build Manifest                                                   │
│     └── Write dist/manifest.json                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Rust Optimization

**Cargo.toml Profile:**

```toml
[profile.release]
lto = "fat"           # Link-time optimization (cross-crate)
codegen-units = 1     # Single codegen unit (better optimization)
panic = "abort"       # Abort on panic (smaller binary)
opt-level = 3         # Maximum optimization
strip = true          # Strip debug symbols
```

**Impact:**

| Metric | Debug | Release | Release + LTO |
|--------|-------|---------|---------------|
| Binary size | 15MB | 8MB | 4MB |
| Startup time | 50ms | 20ms | 15ms |
| Request latency | 500μs | 100μs | 80μs |

### Vite Build

**vite.config.ts:**

```typescript
export default defineConfig({
  build: {
    outDir: '../dist/static',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          vendor: ['framer-motion', 'lucide-react'],
        },
      },
    },
  },
});
```

### Output Structure

```
dist/
├── bin/
│   └── zap                    # 4MB Rust binary
├── static/
│   ├── index.html
│   └── assets/
│       ├── index-[hash].js    # App bundle
│       ├── vendor-[hash].js   # Vendor chunk
│       └── index-[hash].css   # Styles
├── config.json                # Server config
└── manifest.json              # Build metadata
```

### Config Files

**config.json:**

```json
{
  "port": 3000,
  "hostname": "0.0.0.0",
  "ipc_socket_path": "/tmp/zap.sock",
  "max_request_body_size": 10485760,
  "request_timeout_secs": 30,
  "keepalive_timeout_secs": 60,
  "routes": [
    {
      "method": "GET",
      "path": "/api/hello",
      "handler_id": "api_hello_get",
      "is_typescript": true
    }
  ],
  "static_files": [
    {
      "prefix": "/",
      "directory": "./static"
    }
  ],
  "middleware": {
    "enable_cors": true,
    "enable_logging": true,
    "enable_compression": true
  },
  "health_check_path": "/health"
}
```

**manifest.json:**

```json
{
  "version": "1.0.0",
  "buildTime": "2024-01-01T00:00:00.000Z",
  "binaryPath": "./bin/zap",
  "staticDir": "./static",
  "environment": "production",
  "git": {
    "commit": "abc1234",
    "branch": "main"
  }
}
```

## Cross-Compilation

### Setup

```bash
# Install target
rustup target add x86_64-unknown-linux-gnu

# Install linker (macOS)
brew install FiloSottile/musl-cross/musl-cross
```

### Build

```bash
zap build --target x86_64-unknown-linux-gnu
```

### Targets

| Target | Platform | Notes |
|--------|----------|-------|
| `x86_64-unknown-linux-gnu` | Linux x64 | Most common |
| `aarch64-unknown-linux-gnu` | Linux ARM64 | AWS Graviton |
| `x86_64-unknown-linux-musl` | Linux x64 (static) | Alpine |
| `x86_64-apple-darwin` | macOS x64 | Intel Mac |
| `aarch64-apple-darwin` | macOS ARM64 | Apple Silicon |

## Incremental Builds

### Development

Cargo handles incremental compilation:

```bash
# First build: ~30s
cargo build --release

# Incremental: ~2s
touch src/main.rs && cargo build --release
```

### Production

Full rebuild recommended for production:

```bash
# Clean build for production
cargo clean
zap build
```

## Build Hooks

### Pre-build

```typescript
// zap.config.ts
export default defineConfig({
  hooks: {
    preBuild: async () => {
      // Run before build
      await exec('npm run lint');
    },
  },
});
```

### Post-build

```typescript
export default defineConfig({
  hooks: {
    postBuild: async () => {
      // Run after build
      await exec('npm run test');
    },
  },
});
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Build

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: actions-rust-lang/setup-rust-toolchain@v1

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install

      - name: Build
        run: npm run build

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

---

## See Also

- [Architecture](../ARCHITECTURE.md) - System design
- [CLI Reference](../api/cli.md) - Build commands
- [Deployment](../guides/deployment.md) - Production deployment
