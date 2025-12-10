# @zapjs/cli

The `@zapjs/cli` package provides command-line tools for developing, building, and deploying Zap.js applications.

## Installation

```bash
npm install -g @zapjs/cli
# or use via npx
npx @zapjs/cli <command>
```

## Commands

### zap dev

Start the development server with hot reload.

```bash
zap dev [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | API server port | `3000` |
| `--vite-port <port>` | Vite dev server port | `5173` |
| `--skip-build` | Skip initial Rust build | `false` |
| `--no-open` | Don't open browser | `false` |
| `--log-level <level>` | Log level (debug/info/warn/error) | `info` |

**Examples:**

```bash
# Default
zap dev

# Custom ports
zap dev --port 4000 --vite-port 5174

# Skip Rust build (use existing binary)
zap dev --skip-build

# Debug logging
zap dev --log-level debug
```

**What it does:**

1. Compiles Rust backend (`cargo build --release`)
2. Generates TypeScript bindings
3. Scans and generates route tree
4. Starts Vite dev server (frontend HMR)
5. Starts WebSocket hot reload server
6. Spawns Rust binary
7. Watches for file changes

**Keyboard Shortcuts:**

| Key | Action |
|-----|--------|
| `r` | Restart Rust server |
| `c` | Clear console |
| `q` | Quit |

---

### zap build

Build for production.

```bash
zap build [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--output <dir>` | Output directory | `./dist` |
| `--target <target>` | Rust target triple | (native) |
| `--skip-frontend` | Skip Vite build | `false` |
| `--skip-rust` | Skip Rust build | `false` |
| `--release` | Use release profile | `true` |

**Examples:**

```bash
# Default build
zap build

# Custom output
zap build --output ./build

# Cross-compile for Linux
zap build --target x86_64-unknown-linux-gnu

# Skip frontend (API-only)
zap build --skip-frontend
```

**Output Structure:**

```
dist/
├── bin/
│   └── zap              # Rust binary
├── static/              # Frontend assets (Vite output)
│   ├── index.html
│   └── assets/
├── config.json          # Server configuration
└── manifest.json        # Build metadata
```

---

### zap serve

Run the production server.

```bash
zap serve [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Server port | `3000` |
| `--host <host>` | Server hostname | `0.0.0.0` |
| `--config <path>` | Config file path | `./dist/config.json` |
| `--workers <n>` | Worker threads | (auto) |

**Examples:**

```bash
# Default
zap serve

# Custom port and host
zap serve --port 8080 --host 127.0.0.1

# With custom config
zap serve --config ./production.json
```

---

### zap new

Create a new Zap.js project.

```bash
zap new <name> [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-t, --template <name>` | Project template | `basic` |
| `--no-git` | Skip git initialization | `false` |
| `--no-install` | Skip dependency install | `false` |

**Templates:**

| Template | Description |
|----------|-------------|
| `basic` | Minimal setup |
| `fullstack` | React + API routes |

**Examples:**

```bash
# Basic project
zap new my-app

# Fullstack template
zap new my-app --template fullstack

# Skip git
zap new my-app --no-git
```

**Generated Structure (fullstack):**

```
my-app/
├── routes/
│   ├── __root.tsx
│   ├── index.tsx
│   └── api/
│       └── hello.ts
├── src/
│   ├── main.tsx
│   └── App.tsx
├── server/
│   └── src/
│       └── main.rs
├── public/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── zap.config.ts
└── Cargo.toml
```

---

### zap routes

Scan and display routes.

```bash
zap routes [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--json` | Output as JSON | `false` |
| `-o, --output <dir>` | Generate files to directory | - |
| `--watch` | Watch for changes | `false` |

**Examples:**

```bash
# Display routes
zap routes

# Output:
# Routes:
#   /              -> routes/index.tsx
#   /about         -> routes/about.tsx
#   /users/:id     -> routes/users.$id.tsx
#
# API Routes:
#   GET  /api/hello      -> routes/api/hello.ts
#   GET  /api/users/:id  -> routes/api/users.$id.ts
#   PUT  /api/users/:id  -> routes/api/users.$id.ts

# JSON output
zap routes --json

# Generate route tree
zap routes --output ./src/generated

# Watch mode
zap routes --watch --output ./src/generated
```

---

### zap codegen

Generate TypeScript bindings from Rust exports.

```bash
zap codegen [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <dir>` | Output directory | `./src/api` |
| `--project <dir>` | Rust project directory | `.` |
| `--no-definitions` | Skip .d.ts generation | `false` |
| `--no-runtime` | Skip .ts generation | `false` |

**Examples:**

```bash
# Default
zap codegen

# Custom output
zap codegen --output ./src/generated

# From specific Rust project
zap codegen --project ./server --output ./src/api
```

**Generated Files:**

```
src/api/
├── server.ts       # Namespaced client
├── backend.ts      # Flat exports
└── backend.d.ts    # Type definitions
```

---

## Configuration

### zap.config.ts

```typescript
import { defineConfig } from '@zapjs/cli';

export default defineConfig({
  server: {
    port: 3000,
    hostname: '127.0.0.1',
  },
  dev: {
    apiPort: 3000,
    clientPort: 5173,
    watchRust: true,
    watchTypeScript: true,
    open: true,
  },
  build: {
    output: './dist',
    target: undefined,  // Use native
  },
  routes: {
    dir: './routes',
    generatedDir: './src/generated',
  },
});
```

### Configuration Options

```typescript
interface ZapCliConfig {
  server: {
    port: number;
    hostname: string;
  };
  dev: {
    apiPort: number;
    clientPort: number;
    watchRust: boolean;
    watchTypeScript: boolean;
    open: boolean;
  };
  build: {
    output: string;
    target?: string;
  };
  routes: {
    dir: string;
    generatedDir: string;
  };
}
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZAP_PORT` | Override server port |
| `ZAP_HOST` | Override hostname |
| `ZAP_LOG_LEVEL` | Set log level |
| `ZAP_ENV` | Environment (development/production) |

---

## Typical Workflows

### Development

```bash
# Start development
zap dev

# In another terminal, run tests
npm test

# Routes changed? They auto-reload
# Rust changed? Auto-rebuilds
# React changed? HMR updates
```

### Production

```bash
# Build
zap build

# Test locally
zap serve

# Deploy
scp -r dist/ server:/app/
ssh server 'cd /app && ./bin/zap'
```

### Docker

```bash
# Build image
docker build -t my-zap-app .

# Run
docker run -p 3000:3000 my-zap-app
```

---

## See Also

- [Getting Started](../getting-started.md) - First project setup
- [Deployment Guide](../guides/deployment.md) - Production deployment
- [Dev Server API](./dev-server.md) - Programmatic dev server
