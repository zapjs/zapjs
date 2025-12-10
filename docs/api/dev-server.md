# @zapjs/dev-server

The `@zapjs/dev-server` package provides the development orchestration engine for Zap.js, coordinating Rust compilation, TypeScript bundling, hot reload, and route scanning.

## Installation

```bash
npm install @zapjs/dev-server
# or
bun add @zapjs/dev-server
```

## DevServer

The main orchestration class that coordinates all development components.

### Usage

```typescript
import { DevServer } from '@zapjs/dev-server';

const server = new DevServer({
  projectDir: process.cwd(),
  apiPort: 3000,
  vitePort: 5173,
  hotReloadPort: 3001,
  watchRust: true,
  watchRoutes: true,
});

// Event handlers
server.on('ready', () => console.log('Dev server ready'));
server.on('rust:compiled', () => console.log('Rust compiled'));
server.on('routes:updated', (routes) => console.log('Routes:', routes.length));
server.on('error', (err) => console.error('Error:', err));

// Start
await server.start();

// Stop
await server.stop();
```

### Configuration

```typescript
interface DevServerConfig {
  // Project root directory
  projectDir: string;

  // Rust/API server port
  apiPort: number;

  // Vite dev server port
  vitePort: number;

  // Hot reload WebSocket port
  hotReloadPort: number;

  // Watch Rust files for changes
  watchRust: boolean;

  // Watch routes directory
  watchRoutes: boolean;

  // Skip initial Rust build
  skipInitialBuild?: boolean;

  // Log level
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  // Custom binary paths
  binaries?: {
    zap?: string;
    zapCodegen?: string;
  };
}
```

### Events

```typescript
server.on('ready', () => void);
server.on('starting', () => void);
server.on('stopping', () => void);

server.on('rust:compiling', () => void);
server.on('rust:compiled', () => void);
server.on('rust:error', (error: Error) => void);

server.on('routes:scanning', () => void);
server.on('routes:updated', (routes: ScannedRoute[]) => void);
server.on('routes:error', (error: Error) => void);

server.on('codegen:running', () => void);
server.on('codegen:complete', () => void);
server.on('codegen:error', (error: Error) => void);

server.on('vite:ready', () => void);
server.on('vite:error', (error: Error) => void);

server.on('reload', (type: ReloadType, files?: string[]) => void);
server.on('error', (error: Error) => void);
```

### Methods

```typescript
class DevServer extends EventEmitter {
  constructor(config: DevServerConfig);

  // Start all components
  async start(): Promise<void>;

  // Stop all components
  async stop(): Promise<void>;

  // Restart Rust server only
  async restartRust(): Promise<void>;

  // Run codegen manually
  async runCodegen(): Promise<void>;

  // Scan routes manually
  async scanRoutes(): Promise<ScannedRoute[]>;

  // Check if running
  isRunning(): boolean;
}
```

## RustBuilder

Handles Rust compilation with incremental builds.

### Usage

```typescript
import { RustBuilder } from '@zapjs/dev-server';

const builder = new RustBuilder({
  projectDir: './server',
  target: 'release',
  features: [],
});

builder.on('compiling', () => console.log('Compiling...'));
builder.on('compiled', (binary) => console.log('Binary:', binary));
builder.on('error', (err) => console.error('Build error:', err));

// Build
const binaryPath = await builder.build();

// Check if built
if (builder.isBuilt()) {
  console.log('Binary exists at:', builder.getBinaryPath());
}
```

### Configuration

```typescript
interface RustBuilderConfig {
  // Cargo project directory
  projectDir: string;

  // Build profile (debug/release)
  target: 'debug' | 'release';

  // Cargo features to enable
  features?: string[];

  // Target triple for cross-compilation
  targetTriple?: string;
}
```

### API

```typescript
class RustBuilder extends EventEmitter {
  constructor(config: RustBuilderConfig);

  // Build the Rust project
  async build(): Promise<string>;

  // Get binary path
  getBinaryPath(): string;

  // Check if binary exists
  isBuilt(): boolean;

  // Get last build time
  getLastBuildTime(): Date | null;
}
```

## FileWatcher

Watches filesystem for changes.

### Usage

```typescript
import { FileWatcher } from '@zapjs/dev-server';

const watcher = new FileWatcher({
  paths: ['./src', './routes'],
  extensions: ['.ts', '.tsx', '.rs'],
  ignored: ['node_modules', '.git', 'target'],
});

watcher.on('change', (event) => {
  console.log(`${event.type}: ${event.path}`);
});

watcher.on('error', (err) => {
  console.error('Watch error:', err);
});

// Start watching
await watcher.start();

// Stop watching
await watcher.stop();
```

### Events

```typescript
interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

watcher.on('change', (event: WatchEvent) => void);
watcher.on('ready', () => void);
watcher.on('error', (error: Error) => void);
```

## HotReloadServer

WebSocket server for signaling hot reload to browsers.

### Usage

```typescript
import { HotReloadServer } from '@zapjs/dev-server';

const hotReload = new HotReloadServer({
  port: 3001,
});

hotReload.on('connection', (client) => {
  console.log('Client connected');
});

// Start
await hotReload.start();

// Send reload signal
hotReload.reload('full');
hotReload.reload('partial', ['src/App.tsx']);
hotReload.reload('rust');

// Stop
await hotReload.stop();
```

### Reload Types

```typescript
type ReloadType =
  | 'full'        // Full page reload
  | 'partial'     // Partial update (HMR)
  | 'rust'        // Rust server restarted
  | 'typescript'  // TS files changed
  | 'config'      // Config changed
  | 'routes';     // Routes changed
```

### Message Format

```typescript
interface ReloadMessage {
  type: 'reload' | 'update' | 'error' | 'connected';
  target?: ReloadType;
  files?: string[];
  message?: string;
  timestamp: number;
}
```

### Client Integration

```html
<!-- In your HTML -->
<script>
  const ws = new WebSocket('ws://localhost:3001');

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'reload') {
      if (msg.target === 'full' || msg.target === 'rust') {
        window.location.reload();
      }
    }
  };
</script>
```

## ViteProxy

Proxies requests to the Vite dev server.

### Usage

```typescript
import { ViteProxy } from '@zapjs/dev-server';

const proxy = new ViteProxy({
  vitePort: 5173,
  apiPort: 3000,
});

// Start Vite
await proxy.start();

// Check if running
if (proxy.isRunning()) {
  console.log('Vite running on port', proxy.getPort());
}

// Stop
await proxy.stop();
```

## CodegenRunner

Runs TypeScript binding generation.

### Usage

```typescript
import { CodegenRunner } from '@zapjs/dev-server';

const codegen = new CodegenRunner({
  projectDir: './server',
  outputDir: './src/generated',
  binaryPath: './bin/zap-codegen',
});

codegen.on('complete', () => console.log('Codegen complete'));
codegen.on('error', (err) => console.error('Codegen error:', err));

// Run codegen
await codegen.run();
```

## RouteScannerRunner

Watches and regenerates routes.

### Usage

```typescript
import { RouteScannerRunner } from '@zapjs/dev-server';

const scanner = new RouteScannerRunner({
  routesDir: './routes',
  outputDir: './src/generated',
  watch: true,
});

scanner.on('updated', (routes) => {
  console.log('Routes updated:', routes.length);
});

// Start (scans immediately and watches)
await scanner.start();

// Stop watching
await scanner.stop();
```

## Complete Example

```typescript
import {
  DevServer,
  RustBuilder,
  FileWatcher,
  HotReloadServer,
  CodegenRunner,
  RouteScannerRunner,
} from '@zapjs/dev-server';

async function startDevEnvironment() {
  const projectDir = process.cwd();

  // Create dev server with all components
  const server = new DevServer({
    projectDir,
    apiPort: 3000,
    vitePort: 5173,
    hotReloadPort: 3001,
    watchRust: true,
    watchRoutes: true,
    logLevel: 'info',
  });

  // Log events
  server.on('ready', () => {
    console.log('\n  Zap.js Dev Server Ready!');
    console.log('  ─────────────────────────');
    console.log('  API:      http://localhost:3000');
    console.log('  Frontend: http://localhost:5173');
    console.log('  Hot Reload: ws://localhost:3001');
    console.log('\n  Press r to restart, q to quit\n');
  });

  server.on('rust:compiled', () => {
    console.log('  ✓ Rust compiled');
  });

  server.on('routes:updated', (routes) => {
    console.log(`  ✓ ${routes.length} routes discovered`);
  });

  server.on('reload', (type, files) => {
    console.log(`  ↻ Hot reload: ${type}`);
  });

  server.on('error', (err) => {
    console.error('  ✗ Error:', err.message);
  });

  // Handle keyboard input
  process.stdin.setRawMode(true);
  process.stdin.on('data', async (key) => {
    const char = key.toString();

    if (char === 'r') {
      console.log('  Restarting Rust server...');
      await server.restartRust();
    } else if (char === 'c') {
      console.clear();
    } else if (char === 'q' || char === '\u0003') {
      await server.stop();
      process.exit(0);
    }
  });

  // Start
  await server.start();
}

startDevEnvironment().catch(console.error);
```

---

## See Also

- [CLI Reference](./cli.md) - CLI commands
- [Build Pipeline](../internals/build-pipeline.md) - Build system internals
- [Architecture](../ARCHITECTURE.md) - System design
