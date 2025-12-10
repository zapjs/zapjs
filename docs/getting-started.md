# Getting Started

This guide walks you through creating your first Zap.js application.

## Prerequisites

- **Node.js 18+** or **Bun 1.0+**
- **Rust 1.70+** (install via [rustup](https://rustup.rs/))
- **macOS**, **Linux**, or **Windows** (WSL2)

## Create a New Project

### Using create-zap-app

```bash
# With npm
npx create-zap-app my-app

# With bun
bunx create-zap-app my-app
```

### Interactive Prompts

```
? Select a template: (Use arrow keys)
❯ basic     - Minimal setup
  fullstack - React + API routes

? Package manager: (Use arrow keys)
❯ npm
  pnpm
  bun
```

### Project Structure

After creation, your project looks like:

```
my-app/
├── routes/
│   ├── __root.tsx           # Root layout
│   ├── index.tsx            # Home page (/)
│   └── api/
│       └── hello.ts         # API route (/api/hello)
├── src/
│   ├── main.tsx             # React entry
│   └── App.tsx              # Root component
├── server/
│   └── src/
│       └── main.rs          # Rust handlers
├── public/                  # Static assets
├── package.json
├── tsconfig.json
├── vite.config.ts
├── zap.config.ts
└── Cargo.toml
```

## Development

### Start Dev Server

```bash
cd my-app
npm run dev
# or
bun dev
```

This starts:
- **API server** on http://localhost:3000
- **Frontend** on http://localhost:5173 (with HMR)
- **Hot reload** for both Rust and TypeScript

### What Happens

1. Rust backend compiles (`cargo build --release`)
2. TypeScript bindings generate
3. Routes are scanned
4. Vite starts for frontend HMR
5. File watchers enable hot reload

### Development Output

```
  Zap.js Dev Server Ready!
  ─────────────────────────
  API:      http://localhost:3000
  Frontend: http://localhost:5173
  Hot Reload: ws://localhost:3001

  Press r to restart, q to quit
```

## Your First Page

### Create a Page

**`routes/about.tsx`**

```tsx
export default function AboutPage() {
  return (
    <div>
      <h1>About</h1>
      <p>This is my Zap.js app!</p>
    </div>
  );
}
```

Visit http://localhost:5173/about

### Create an API Route

**`routes/api/users.ts`**

```typescript
import type { ZapRequest } from '@zapjs/runtime';

// GET /api/users
export const GET = async (req: ZapRequest) => {
  const { page = '1' } = req.query;

  return {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
    page: parseInt(page),
  };
};

// POST /api/users
export const POST = async (req: ZapRequest) => {
  const body = JSON.parse(req.body);

  return {
    status: 201,
    body: { id: 3, ...body },
  };
};
```

Test it:

```bash
# GET
curl http://localhost:3000/api/users

# POST
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Charlie"}'
```

## Using the API in React

### Fetch Data

```tsx
// src/components/UserList.tsx
import { useState, useEffect } from 'react';

interface User {
  id: number;
  name: string;
}

export function UserList() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch('/api/users')
      .then(res => res.json())
      .then(data => setUsers(data.users));
  }, []);

  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

## Dynamic Routes

### Create Dynamic Route

**`routes/users/$id.tsx`**

```tsx
interface Props {
  params: { id: string };
}

export default function UserPage({ params }: Props) {
  return <h1>User {params.id}</h1>;
}
```

**`routes/api/users.$id.ts`**

```typescript
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;

  return {
    id: parseInt(id),
    name: `User ${id}`,
  };
};
```

## Layouts

### Root Layout

**`routes/__root.tsx`**

```tsx
interface Props {
  children: React.ReactNode;
}

export default function RootLayout({ children }: Props) {
  return (
    <html>
      <head>
        <title>My Zap App</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>© 2024</footer>
      </body>
    </html>
  );
}
```

## Production Build

### Build

```bash
npm run build
# or
bun run build
```

Output in `dist/`:

```
dist/
├── bin/zap          # Rust binary
├── static/          # Frontend assets
├── config.json
└── manifest.json
```

### Run Production Server

```bash
npm run serve
# or
cd dist && ./bin/zap
```

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
    open: true,  // Open browser
  },
  build: {
    output: './dist',
  },
  routes: {
    dir: './routes',
    generatedDir: './src/generated',
  },
});
```

## Common Commands

| Command | Description |
|---------|-------------|
| `zap dev` | Start development server |
| `zap build` | Build for production |
| `zap serve` | Run production server |
| `zap routes` | Display route tree |
| `zap codegen` | Generate TypeScript bindings |

## Next Steps

- [File-Based Routing](./guides/file-routing.md) - Learn routing patterns
- [API Routes](./guides/api-routes.md) - Build API handlers
- [Server Functions](./guides/server-functions.md) - Call Rust from TypeScript
- [Deployment](./guides/deployment.md) - Deploy to production
- [Architecture](./ARCHITECTURE.md) - Understand the system

## Troubleshooting

### Rust Not Found

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Verify
rustc --version
cargo --version
```

### Port Already in Use

```bash
# Use different ports
zap dev --port 4000 --vite-port 5174
```

### Build Fails

```bash
# Clean and rebuild
rm -rf target dist node_modules
npm install
npm run build
```

### Hot Reload Not Working

Check that you're editing files in watched directories:
- `routes/` - Route files
- `src/` - React components
- `server/src/` - Rust code

---

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical deep-dive
- [CLI Reference](./api/cli.md) - All CLI commands
- [Examples](https://github.com/zapjs/examples) - Sample projects
