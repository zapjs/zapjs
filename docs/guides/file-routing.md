# File-Based Routing

Zap.js uses TanStack Router-style file conventions for automatic route discovery. This guide covers all routing patterns and best practices.

## Route Directory

Routes are defined in the `routes/` directory at your project root:

```
my-app/
├── routes/           # Route files here
│   ├── index.tsx     # /
│   └── about.tsx     # /about
└── src/
    └── main.tsx
```

## Basic Patterns

### Index Routes

`index.tsx` files render at the parent path:

```
routes/
├── index.tsx         # /
├── users/
│   └── index.tsx     # /users
└── settings/
    └── index.tsx     # /settings
```

### Named Routes

Files named after the route segment:

```
routes/
├── about.tsx         # /about
├── contact.tsx       # /contact
└── pricing.tsx       # /pricing
```

### Nested Routes

Directory structure maps to URL structure:

```
routes/
├── blog/
│   ├── index.tsx     # /blog
│   └── archive.tsx   # /blog/archive
└── docs/
    ├── index.tsx     # /docs
    └── api.tsx       # /docs/api
```

## Dynamic Routes

### Single Parameter

Prefix with `$` for dynamic segments:

```
routes/
├── users/
│   └── $id.tsx       # /users/:id
└── posts/
    └── $slug.tsx     # /posts/:slug
```

**Example: `routes/users/$id.tsx`**

```tsx
import type { ZapRequest } from '@zapjs/runtime';

export default function UserPage({ params }: { params: { id: string } }) {
  return <h1>User {params.id}</h1>;
}

// API route version
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;
  return { userId: id };
};
```

### Dot Notation

Use dots for cleaner file names with multiple segments:

```
routes/
├── users.$id.tsx           # /users/:id
├── posts.$postId.tsx       # /posts/:postId
└── blog.$year.$month.tsx   # /blog/:year/:month
```

### Multiple Parameters

```
routes/
└── users.$userId.posts.$postId.tsx   # /users/:userId/posts/:postId
```

**Example: `routes/users.$userId.posts.$postId.tsx`**

```tsx
export const GET = async (req: ZapRequest) => {
  const { userId, postId } = req.params;
  return { userId, postId };
};
```

## Layouts

### Root Layout

`__root.tsx` wraps all routes:

```tsx
// routes/__root.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <title>My App</title>
      </head>
      <body>
        <nav>...</nav>
        {children}
        <footer>...</footer>
      </body>
    </html>
  );
}
```

### Nested Layouts

`_layout.tsx` wraps sibling routes:

```
routes/
├── _layout.tsx           # Wraps all routes
├── index.tsx
├── dashboard/
│   ├── _layout.tsx       # Wraps dashboard routes
│   ├── index.tsx         # /dashboard
│   └── settings.tsx      # /dashboard/settings
```

**Example: `routes/dashboard/_layout.tsx`**

```tsx
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dashboard">
      <aside>
        <DashboardNav />
      </aside>
      <main>{children}</main>
    </div>
  );
}
```

## Route Groups

### Logical Grouping

Parentheses create groups without URL segments:

```
routes/
├── (marketing)/
│   ├── about.tsx         # /about
│   └── pricing.tsx       # /pricing
├── (app)/
│   ├── dashboard.tsx     # /dashboard
│   └── settings.tsx      # /settings
```

### Shared Layouts

Groups can share layouts:

```
routes/
├── (auth)/
│   ├── _layout.tsx       # Auth layout
│   ├── login.tsx         # /login
│   └── register.tsx      # /register
├── (dashboard)/
│   ├── _layout.tsx       # Dashboard layout
│   └── home.tsx          # /home
```

## Exclusions

### Excluded Files

Prefix with `-` to exclude from routing:

```
routes/
├── -components/          # Not a route
│   └── Button.tsx
├── -utils/               # Not a route
│   └── helpers.ts
└── index.tsx             # /
```

### Ignored Patterns

These are automatically excluded:
- Files starting with `_` (except `_layout.tsx`)
- Files starting with `-`
- `node_modules`
- `.git`
- Test files (`*.test.ts`, `*.spec.ts`)

## API Routes

### API Directory

Place API routes in `routes/api/`:

```
routes/
├── index.tsx             # Page: /
└── api/
    ├── hello.ts          # API: /api/hello
    ├── users.ts          # API: /api/users
    └── users.$id.ts      # API: /api/users/:id
```

### HTTP Method Exports

Export named functions for HTTP methods:

```typescript
// routes/api/users.ts

export const GET = async (req: ZapRequest) => {
  return { users: [...] };
};

export const POST = async (req: ZapRequest) => {
  const body = JSON.parse(req.body);
  return { created: body };
};
```

### API Route Example

**`routes/api/users.$id.ts`**

```typescript
import type { ZapRequest } from '@zapjs/runtime';

// GET /api/users/:id
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;

  const user = await db.users.findById(id);
  if (!user) {
    return {
      status: 404,
      body: { error: 'User not found' },
    };
  }

  return user;
};

// PUT /api/users/:id
export const PUT = async (req: ZapRequest) => {
  const { id } = req.params;
  const updates = JSON.parse(req.body);

  const user = await db.users.update(id, updates);
  return user;
};

// DELETE /api/users/:id
export const DELETE = async (req: ZapRequest) => {
  const { id } = req.params;

  await db.users.delete(id);
  return { deleted: true };
};
```

## Complete Example

### Project Structure

```
my-app/
├── routes/
│   ├── __root.tsx                    # Root layout
│   ├── index.tsx                     # /
│   ├── about.tsx                     # /about
│   │
│   ├── (marketing)/
│   │   ├── _layout.tsx               # Marketing layout
│   │   ├── features.tsx              # /features
│   │   └── pricing.tsx               # /pricing
│   │
│   ├── dashboard/
│   │   ├── _layout.tsx               # Dashboard layout
│   │   ├── index.tsx                 # /dashboard
│   │   ├── settings.tsx              # /dashboard/settings
│   │   └── users/
│   │       ├── index.tsx             # /dashboard/users
│   │       └── $id.tsx               # /dashboard/users/:id
│   │
│   ├── blog/
│   │   ├── index.tsx                 # /blog
│   │   ├── $slug.tsx                 # /blog/:slug
│   │   └── $year.$month.tsx          # /blog/:year/:month
│   │
│   ├── api/
│   │   ├── hello.ts                  # /api/hello
│   │   ├── users.ts                  # /api/users
│   │   ├── users.$id.ts              # /api/users/:id
│   │   └── posts.$id.comments.ts     # /api/posts/:id/comments
│   │
│   └── -components/                  # Excluded
│       ├── Header.tsx
│       └── Footer.tsx
│
├── src/
│   └── main.tsx
├── zap.config.ts
└── package.json
```

### Generated Route Manifest

```json
{
  "routes": [
    { "urlPath": "/", "filePath": "routes/index.tsx" },
    { "urlPath": "/about", "filePath": "routes/about.tsx" },
    { "urlPath": "/features", "filePath": "routes/(marketing)/features.tsx" },
    { "urlPath": "/pricing", "filePath": "routes/(marketing)/pricing.tsx" },
    { "urlPath": "/dashboard", "filePath": "routes/dashboard/index.tsx" },
    { "urlPath": "/dashboard/settings", "filePath": "routes/dashboard/settings.tsx" },
    { "urlPath": "/dashboard/users", "filePath": "routes/dashboard/users/index.tsx" },
    { "urlPath": "/dashboard/users/:id", "filePath": "routes/dashboard/users/$id.tsx" },
    { "urlPath": "/blog", "filePath": "routes/blog/index.tsx" },
    { "urlPath": "/blog/:slug", "filePath": "routes/blog/$slug.tsx" },
    { "urlPath": "/blog/:year/:month", "filePath": "routes/blog/$year.$month.tsx" }
  ],
  "apiRoutes": [
    { "urlPath": "/api/hello", "filePath": "routes/api/hello.ts", "methods": ["GET"] },
    { "urlPath": "/api/users", "filePath": "routes/api/users.ts", "methods": ["GET", "POST"] },
    { "urlPath": "/api/users/:id", "filePath": "routes/api/users.$id.ts", "methods": ["GET", "PUT", "DELETE"] },
    { "urlPath": "/api/posts/:id/comments", "filePath": "routes/api/posts.$id.comments.ts", "methods": ["GET", "POST"] }
  ]
}
```

## Pattern Reference

| File Pattern | URL Path | Notes |
|--------------|----------|-------|
| `index.tsx` | `/` | Index route |
| `about.tsx` | `/about` | Static route |
| `$id.tsx` | `/:id` | Dynamic param |
| `users.$id.tsx` | `/users/:id` | Nested dynamic |
| `$a.$b.tsx` | `/:a/:b` | Multiple params |
| `_layout.tsx` | - | Layout wrapper |
| `__root.tsx` | - | Root layout |
| `(group)/` | - | Route group |
| `-excluded/` | - | Excluded |
| `api/*.ts` | `/api/*` | API route |

---

## See Also

- [API Routes Guide](./api-routes.md) - API handler patterns
- [Router API](../api/router.md) - Programmatic API
- [Architecture](../ARCHITECTURE.md) - System design
