# ZapJS Usage Guide

This guide covers all ZapJS features with practical examples. Use this as a reference when building your fullstack applications.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Rust Backend Functions](#rust-backend-functions)
3. [API Routes](#api-routes)
4. [Page Routes](#page-routes)
5. [Dynamic Routes](#dynamic-routes)
6. [Layouts](#layouts)
7. [Route Groups](#route-groups)
8. [Streaming Responses](#streaming-responses)
9. [WebSocket Handlers](#websocket-handlers)
10. [Static Site Generation](#static-site-generation)
11. [Error Handling](#error-handling)
12. [Client-Side Router](#client-side-router)
13. [Type Safety](#type-safety)
14. [Configuration](#configuration)

---

## Getting Started

### Create a New Project

```bash
npx create-zap my-app
cd my-app
```

### Project Structure

```
my-app/
├── routes/           # API and page routes
├── src/              # React components, generated files
├── server/           # Rust backend
├── package.json
└── zap.config.ts
```

### Development

```bash
# Start dev server (runs both Rust and TypeScript)
npm run dev

# Or using zap CLI directly
zap dev
```

### Production Build

```bash
npm run build
npm run serve
```

---

## Rust Backend Functions

Define backend functions in Rust with the `#[export]` attribute.

### Basic Function

```rust
// server/src/main.rs
use zap_server::export;

#[export]
pub async fn hello() -> String {
    "Hello from Rust!".to_string()
}
```

### With Parameters

```rust
#[export]
pub async fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
```

### With Custom Types

```rust
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[export]
pub async fn get_user(id: String) -> User {
    User {
        id,
        name: "John Doe".to_string(),
        email: "john@example.com".to_string(),
    }
}

#[export]
pub async fn list_users(limit: u32, offset: u32) -> Vec<User> {
    // Return paginated users
    vec![]
}
```

### Error Handling with Result

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[export]
pub async fn get_user_safe(id: String) -> Result<User, ApiError> {
    if id.is_empty() {
        return Err(ApiError {
            code: "INVALID_ID".to_string(),
            message: "User ID cannot be empty".to_string(),
        });
    }

    Ok(User {
        id,
        name: "John".to_string(),
        email: "john@example.com".to_string(),
    })
}
```

### Run Codegen

After adding/modifying Rust functions:

```bash
zap-codegen
# Or during development, it runs automatically
```

This generates TypeScript bindings in `src/api/`:

```typescript
// Generated: src/api/backend.ts
export const backend = {
  async hello(): Promise<string> {
    return rpcCall<string>('hello', {});
  },

  async greet(name: string): Promise<string> {
    return rpcCall<string>('greet', { name });
  },

  async getUser(id: string): Promise<User> {
    return rpcCall<User>('get_user', { id });
  },

  async getUserSafe(id: string): Promise<User | ApiError> {
    return rpcCall<User | ApiError>('get_user_safe', { id });
  },
};
```

---

## API Routes

Create API endpoints in the `routes/api/` directory.

### Basic GET Handler

```typescript
// routes/api/hello.ts
export const GET = async () => {
  return { message: 'Hello World' };
};
```

Accessible at: `GET /api/hello`

### All HTTP Methods

```typescript
// routes/api/users.ts
import type { ZapRequest } from '@zapjs/runtime';
import { backend } from '../../src/api/backend';

export const GET = async (req: ZapRequest) => {
  const limit = parseInt(req.query.limit || '10');
  const offset = parseInt(req.query.offset || '0');
  return backend.listUsers(limit, offset);
};

export const POST = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.createUser(body.name, body.email, body.role);
};

export const PUT = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.updateUser(body.id, body.name, body.email, body.role);
};

export const DELETE = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.deleteUser(body.id);
};
```

### Request Object

```typescript
interface ZapRequest {
  method: string;              // GET, POST, etc.
  path: string;                // /api/users?limit=10
  pathOnly: string;            // /api/users
  query: Record<string, string>;   // { limit: '10' }
  params: Record<string, string>;  // URL params (:id)
  headers: Record<string, string>;
  cookies: Record<string, string>;

  json<T>(): Promise<T>;       // Parse JSON body
  text(): Promise<string>;     // Get raw body
}
```

### Custom Response

```typescript
export const GET = async () => {
  return {
    $status: 201,
    $headers: {
      'X-Custom-Header': 'value',
      'Cache-Control': 'max-age=3600',
    },
    data: { created: true },
  };
};
```

### Redirect

```typescript
export const GET = async () => {
  return {
    $status: 302,
    $headers: { Location: '/new-location' },
  };
};
```

---

## Page Routes

React components for pages.

### Basic Page

```tsx
// routes/index.tsx
export default function Home() {
  return (
    <div>
      <h1>Welcome to ZapJS</h1>
    </div>
  );
}
```

### Page with Data Fetching

```tsx
// routes/users.tsx
import { useState, useEffect } from 'react';
import { backend, User } from '../src/api/backend';

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    backend.listUsers(10, 0)
      .then(response => {
        setUsers(response.users);
        setLoading(false);
      });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

---

## Dynamic Routes

### URL Parameters

```tsx
// routes/users/[id].tsx
// Matches: /users/123, /users/abc

interface Props {
  params: { id: string };
}

export default function UserProfile({ params }: Props) {
  return <h1>User ID: {params.id}</h1>;
}
```

### Dot-Separated Parameters

```typescript
// routes/api/users.$id.ts
// Matches: /api/users/123

export const GET = async (req: ZapRequest) => {
  const { id } = req.params;
  return backend.getUser(id);
};
```

### Catch-All Routes

```tsx
// routes/docs/[...slug].tsx
// Matches: /docs/intro, /docs/api/users, /docs/a/b/c

interface Props {
  params: { slug: string };  // "intro" or "api/users" or "a/b/c"
}

export default function DocsPage({ params }: Props) {
  const parts = params.slug.split('/');
  return <h1>Docs: {parts.join(' > ')}</h1>;
}
```

### Optional Catch-All

```tsx
// routes/shop/[[...categories]].tsx
// Matches: /shop, /shop/electronics, /shop/electronics/phones

interface Props {
  params: { categories?: string };
}

export default function ShopPage({ params }: Props) {
  const categories = params.categories?.split('/') || [];
  return <h1>Categories: {categories.length || 'All'}</h1>;
}
```

---

## Layouts

Wrap pages with shared UI.

### Root Layout

```tsx
// routes/_layout.tsx
import { Outlet } from '@zapjs/runtime';

export default function RootLayout() {
  return (
    <html>
      <head>
        <title>My App</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
        <main>
          <Outlet />  {/* Child routes render here */}
        </main>
        <footer>Copyright 2024</footer>
      </body>
    </html>
  );
}
```

### Nested Layout

```tsx
// routes/dashboard/_layout.tsx
// Applies to all /dashboard/* routes

import { Outlet } from '@zapjs/runtime';

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>
        <nav>Dashboard Menu</nav>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
```

---

## Route Groups

Organize routes without affecting URLs.

```
routes/
├── (marketing)/
│   ├── about.tsx      # /about
│   ├── contact.tsx    # /contact
│   └── _layout.tsx    # Marketing layout
├── (app)/
│   ├── dashboard.tsx  # /dashboard
│   ├── settings.tsx   # /settings
│   └── _layout.tsx    # App layout
└── index.tsx          # /
```

The parentheses folder name is ignored in the URL path.

---

## Streaming Responses

For large data or server-sent events.

### Basic Streaming

```typescript
// routes/api/stream.ts
export const GET = async function* () {
  yield { data: 'Starting...\n' };

  for (let i = 1; i <= 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    yield { data: `Progress: ${i}/5\n` };
  }

  yield { data: 'Complete!\n' };
};
```

### Server-Sent Events (SSE)

```typescript
// routes/api/events.ts
export const GET = async function* () {
  // Set proper headers for SSE
  yield {
    $headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  };

  let id = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    yield {
      data: `event: tick\nid: ${++id}\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`
    };
  }
};
```

### Client-Side Consumption

```typescript
const eventSource = new EventSource('/api/events');

eventSource.addEventListener('tick', (event) => {
  const data = JSON.parse(event.data);
  console.log('Tick:', data.time);
});
```

---

## WebSocket Handlers

Real-time bidirectional communication.

### Basic WebSocket

```typescript
// routes/api/ws-chat.ts
import type { WsConnection, WsHandler } from '@zapjs/runtime';

const clients = new Map<string, WsConnection>();

export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    console.log(`Client connected: ${connection.id}`);
    clients.set(connection.id, connection);

    // Welcome message
    connection.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to chat!',
      clientCount: clients.size,
    }));

    // Notify others
    broadcast({
      type: 'user_joined',
      userId: connection.id,
    }, connection.id);
  },

  onMessage: async (connection, message) => {
    const text = typeof message === 'string'
      ? message
      : new TextDecoder().decode(message);

    try {
      const parsed = JSON.parse(text);

      switch (parsed.type) {
        case 'chat':
          broadcast({
            type: 'chat',
            from: connection.id,
            message: parsed.message,
            timestamp: Date.now(),
          });
          break;

        case 'ping':
          connection.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch {
      // Echo raw text
      connection.send(JSON.stringify({
        type: 'echo',
        message: text,
      }));
    }
  },

  onClose: async (connection, code, reason) => {
    console.log(`Client disconnected: ${connection.id}`);
    clients.delete(connection.id);

    broadcast({
      type: 'user_left',
      userId: connection.id,
    });
  },

  onError: async (connection, error) => {
    console.error(`WebSocket error: ${error.message}`);
  },
};

function broadcast(data: object, excludeId?: string) {
  const message = JSON.stringify(data);
  for (const [id, client] of clients) {
    if (id !== excludeId) {
      client.send(message);
    }
  }
}
```

### Client Connection

```typescript
const ws = new WebSocket('ws://localhost:3000/api/ws-chat');

ws.onopen = () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'chat', message: 'Hello!' }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};

ws.onclose = () => {
  console.log('Disconnected');
};
```

### Binary Data

```typescript
// Send binary
connection.sendBinary(new Uint8Array([1, 2, 3, 4]));

// Receive binary
onMessage: async (connection, message) => {
  if (message instanceof Uint8Array) {
    console.log('Binary data:', message);
  }
}
```

---

## Static Site Generation

Pre-render pages at build time.

### Basic SSG

```tsx
// routes/blog/[slug].tsx
import { rpcCall } from '../../src/generated/rpc-client';

interface Post {
  slug: string;
  title: string;
  content: string;
}

// Called at build time to get all paths
export async function generateStaticParams() {
  const response = await rpcCall<{ posts: Post[] }>('list_posts', {
    page: 1,
    limit: 100,
    tag: null,
    author: null,
  });

  return response.posts.map(post => ({
    slug: post.slug,
  }));
}

// Rendered for each slug
export default function BlogPost({ params }: { params: { slug: string } }) {
  const [post, setPost] = useState<Post | null>(null);

  useEffect(() => {
    rpcCall<Post>('get_post', { id: params.slug })
      .then(setPost);
  }, [params.slug]);

  if (!post) return <div>Loading...</div>;

  return (
    <article>
      <h1>{post.title}</h1>
      <div>{post.content}</div>
    </article>
  );
}
```

### What Gets Generated

At build time:
- `/blog/hello-world` → `dist/blog/hello-world/index.html`
- `/blog/intro-to-rust` → `dist/blog/intro-to-rust/index.html`
- etc.

---

## Error Handling

### Error Boundary Component

```tsx
// routes/blog/[slug].tsx

// Main component
export default function BlogPost({ params }) {
  // ...
}

// Error boundary (shown when component throws)
export function errorComponent({ error, reset }: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="error-page">
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

### Loading State

```tsx
// Shown while component is loading (lazy import)
export function pendingComponent() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>Loading...</p>
    </div>
  );
}
```

### API Error Responses

```typescript
// routes/api/users.$id.ts
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;
  const result = await backend.getUserSafe(id);

  // Check if it's an error (Result<T, E> becomes T | E)
  if ('code' in result && 'message' in result) {
    return {
      $status: 404,
      error: result,
    };
  }

  return result;
};
```

---

## Client-Side Router

### Router Components

```tsx
// Import from runtime
import {
  RouterProvider,
  Link,
  NavLink,
  useRouter,
  usePathname,
  useParams,
  useSearchParams,
  Redirect,
} from '@zapjs/runtime';
```

### Link Component

```tsx
// Simple navigation
<Link to="/about">About</Link>

// With query params
<Link to="/search?q=zapjs">Search</Link>

// External link (uses regular <a>)
<Link to="https://github.com/saint0x/zapjs" external>GitHub</Link>
```

### NavLink (Active Styling)

```tsx
<NavLink
  to="/dashboard"
  className={({ isActive }) =>
    isActive ? 'nav-link active' : 'nav-link'
  }
>
  Dashboard
</NavLink>
```

### Programmatic Navigation

```tsx
import { useRouter } from '@zapjs/runtime';

function MyComponent() {
  const router = useRouter();

  const handleClick = () => {
    router.push('/dashboard');
  };

  const handleReplace = () => {
    router.replace('/login');  // No history entry
  };

  const handleBack = () => {
    router.back();
  };

  return (
    <button onClick={handleClick}>Go to Dashboard</button>
  );
}
```

### Route Hooks

```tsx
import { usePathname, useParams, useSearchParams } from '@zapjs/runtime';

function MyComponent() {
  const pathname = usePathname();  // '/blog/hello-world'
  const params = useParams();      // { slug: 'hello-world' }
  const searchParams = useSearchParams();  // URLSearchParams

  const page = searchParams.get('page') || '1';

  return <div>Current: {pathname}, Page: {page}</div>;
}
```

### Redirect Component

```tsx
import { Redirect } from '@zapjs/runtime';

function ProtectedRoute({ children, isAuthenticated }) {
  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }
  return children;
}
```

---

## Type Safety

### Generated Types

All Rust types are available in TypeScript:

```typescript
// Import from generated files
import type {
  User,
  Post,
  ApiError,
  ListUsersResponse,
} from '../src/api/types';

import { backend } from '../src/api/backend';
```

### Result Types

Rust `Result<T, E>` becomes TypeScript union `T | E`:

```typescript
// Rust: Result<User, ApiError>
// TypeScript: User | ApiError

const result = await backend.getUserSafe('123');

// Type guard
if ('code' in result) {
  // result is ApiError
  console.error(result.message);
} else {
  // result is User
  console.log(result.name);
}
```

### Optional Types

Rust `Option<T>` becomes TypeScript `T | null`:

```typescript
// Rust: Option<String>
// TypeScript: string | null

const bio = user.bio;  // string | null
if (bio !== null) {
  console.log(bio.toUpperCase());
}
```

### Route Path Types

Generated route paths are type-safe:

```typescript
import type { RoutePath } from '../src/generated/routeTree';

// Type-safe paths
const path: RoutePath = '/blog/:slug';  // Valid
const path: RoutePath = '/invalid';     // Type error
```

---

## Configuration

### zap.config.ts

```typescript
import { defineConfig } from '@zapjs/cli';

export default defineConfig({
  // Server options
  server: {
    port: 3000,
    host: '127.0.0.1',
  },

  // Route options
  routes: {
    dir: './routes',
    apiPrefix: '/api',
  },

  // Build options
  build: {
    outDir: './dist',
    minify: true,
    sourcemap: false,
  },

  // SSG options
  ssg: {
    enabled: true,
    routes: ['/blog/*'],  // Glob patterns for SSG
  },
});
```

### Environment Variables

```typescript
// Access in routes/handlers
const apiKey = process.env.API_KEY;

// In Rust
let api_key = std::env::var("API_KEY").unwrap();
```

---

## Quick Reference

### File Naming Conventions

| Pattern | URL | Description |
|---------|-----|-------------|
| `index.tsx` | `/` | Index route |
| `about.tsx` | `/about` | Static route |
| `[id].tsx` | `/:id` | Dynamic param |
| `[...slug].tsx` | `/*slug` | Catch-all |
| `[[...slug]].tsx` | `/*slug?` | Optional catch-all |
| `posts.$id.ts` | `/posts/:id` | API with param |
| `_layout.tsx` | - | Layout |
| `(group)/` | - | Route group |

### Special Exports

| Export | Type | Purpose |
|--------|------|---------|
| `default` | Component | Page/Route component |
| `GET`, `POST`, etc. | Function | API handlers |
| `WEBSOCKET` | WsHandler | WebSocket handler |
| `errorComponent` | Component | Error boundary |
| `pendingComponent` | Component | Loading state |
| `meta` | Function | Head/metadata |
| `middleware` | Array | Route middleware |
| `generateStaticParams` | Function | SSG params |

### Runtime Imports

```typescript
import {
  // Router
  RouterProvider,
  Link,
  NavLink,
  useRouter,
  usePathname,
  useParams,
  useSearchParams,
  Redirect,
  Outlet,

  // Error handling
  ErrorBoundary,
  useRouteError,

  // WebSocket types
  WsConnection,
  WsHandler,

  // Logger
  logger,
} from '@zapjs/runtime';
```

---

## Examples

### Full CRUD API

```typescript
// routes/api/posts.ts
export const GET = async (req: ZapRequest) => {
  const page = parseInt(req.query.page || '1');
  const limit = parseInt(req.query.limit || '10');
  return backend.listPosts(page, limit, null, null);
};

export const POST = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.createPost(body.title, body.content, body.tags);
};

// routes/api/posts.$id.ts
export const GET = async (req: ZapRequest) => {
  return backend.getPost(req.params.id);
};

export const PUT = async (req: ZapRequest) => {
  const body = await req.json();
  return backend.updatePost(req.params.id, body);
};

export const DELETE = async (req: ZapRequest) => {
  return backend.deletePost(req.params.id);
};
```

### Authenticated Route

```typescript
// routes/api/me.ts
export const GET = async (req: ZapRequest) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return { $status: 401, error: 'Unauthorized' };
  }

  const user = await backend.validateToken(token);
  if ('error' in user) {
    return { $status: 401, error: user.error };
  }

  return user;
};
```

### Real-time Dashboard

```typescript
// routes/api/ws-dashboard.ts
export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    // Start sending stats every second
    const interval = setInterval(async () => {
      const stats = await backend.getStats();
      connection.send(JSON.stringify({ type: 'stats', data: stats }));
    }, 1000);

    // Store interval for cleanup
    (connection as any).interval = interval;
  },

  onClose: async (connection) => {
    clearInterval((connection as any).interval);
  },

  onMessage: async () => {},
  onError: async () => {},
};
```

---

For more details, see the [Architecture Documentation](./ARCHITECTURE.md).
