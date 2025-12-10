# API Routes

API routes in Zap.js let you create HTTP endpoints using file-based routing. This guide covers request handling, response formats, and best practices.

## Basic Structure

API routes live in `routes/api/`:

```
routes/
└── api/
    ├── hello.ts          # /api/hello
    ├── users.ts          # /api/users
    └── users.$id.ts      # /api/users/:id
```

## HTTP Method Exports

Export named functions for each HTTP method:

```typescript
// routes/api/users.ts

export const GET = async (req: ZapRequest) => {
  return { users: [] };
};

export const POST = async (req: ZapRequest) => {
  const body = JSON.parse(req.body);
  return { created: body };
};

export const PUT = async (req: ZapRequest) => { ... };
export const DELETE = async (req: ZapRequest) => { ... };
export const PATCH = async (req: ZapRequest) => { ... };
export const HEAD = async (req: ZapRequest) => { ... };
export const OPTIONS = async (req: ZapRequest) => { ... };
```

## Request Object

Every handler receives a `ZapRequest`:

```typescript
interface ZapRequest {
  method: string;                    // "GET", "POST", etc.
  path: string;                      // "/api/users?page=1"
  path_only: string;                 // "/api/users"
  query: Record<string, string>;     // { page: "1" }
  params: Record<string, string>;    // { id: "123" }
  headers: Record<string, string>;   // { "content-type": "..." }
  body: string;                      // Raw body string
  cookies: Record<string, string>;   // { session: "..." }
}
```

### Accessing Request Data

```typescript
export const GET = async (req: ZapRequest) => {
  // Route parameters
  const { id } = req.params;

  // Query string
  const page = req.query.page || '1';
  const limit = req.query.limit || '10';

  // Headers
  const auth = req.headers.authorization;
  const contentType = req.headers['content-type'];

  // Cookies
  const session = req.cookies.session;

  return { id, page, limit };
};

export const POST = async (req: ZapRequest) => {
  // Parse JSON body
  const body = JSON.parse(req.body);

  // Parse form data
  const form = new URLSearchParams(req.body);
  const name = form.get('name');

  return { received: body };
};
```

## Response Formats

### Object Response (JSON)

Return an object for automatic JSON serialization:

```typescript
export const GET = async () => {
  return {
    message: 'Hello',
    timestamp: Date.now(),
  };
};
// Response: 200 OK, Content-Type: application/json
// Body: {"message":"Hello","timestamp":1234567890}
```

### Custom Status and Headers

Return an object with `status`, `headers`, and `body`:

```typescript
export const POST = async (req: ZapRequest) => {
  const user = JSON.parse(req.body);

  return {
    status: 201,
    headers: {
      'Location': `/api/users/${user.id}`,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: { id: user.id, created: true },
  };
};
```

### String Response

Return a string for plain text:

```typescript
export const GET = async () => {
  return 'Hello, World!';
};
// Response: 200 OK, Content-Type: text/plain
```

### Empty Response

Return null/undefined or status-only:

```typescript
export const DELETE = async () => {
  return { status: 204 };
};
// Response: 204 No Content
```

## Error Handling

### Error Responses

Return error objects with appropriate status:

```typescript
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;

  const user = await db.users.findById(id);

  if (!user) {
    return {
      status: 404,
      body: {
        error: 'Not Found',
        message: `User ${id} not found`,
      },
    };
  }

  return user;
};
```

### Try-Catch

Handle errors gracefully:

```typescript
export const POST = async (req: ZapRequest) => {
  try {
    const body = JSON.parse(req.body);
    const result = await createUser(body);
    return { status: 201, body: result };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        status: 400,
        body: { error: 'Invalid JSON' },
      };
    }

    if (error.code === 'VALIDATION_ERROR') {
      return {
        status: 422,
        body: { error: 'Validation failed', details: error.details },
      };
    }

    console.error('Unexpected error:', error);
    return {
      status: 500,
      body: { error: 'Internal Server Error' },
    };
  }
};
```

## Common Patterns

### CRUD Operations

**`routes/api/users.ts`**

```typescript
import type { ZapRequest } from '@zapjs/runtime';

// In-memory store (replace with database)
let users = [
  { id: '1', name: 'Alice', email: 'alice@example.com' },
  { id: '2', name: 'Bob', email: 'bob@example.com' },
];

// GET /api/users - List all users
export const GET = async (req: ZapRequest) => {
  const { page = '1', limit = '10' } = req.query;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const end = start + parseInt(limit);

  return {
    users: users.slice(start, end),
    total: users.length,
    page: parseInt(page),
    limit: parseInt(limit),
  };
};

// POST /api/users - Create user
export const POST = async (req: ZapRequest) => {
  const body = JSON.parse(req.body);

  if (!body.name || !body.email) {
    return {
      status: 400,
      body: { error: 'Name and email required' },
    };
  }

  const user = {
    id: String(users.length + 1),
    name: body.name,
    email: body.email,
  };

  users.push(user);

  return {
    status: 201,
    headers: { 'Location': `/api/users/${user.id}` },
    body: user,
  };
};
```

**`routes/api/users.$id.ts`**

```typescript
import type { ZapRequest } from '@zapjs/runtime';

// GET /api/users/:id
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;
  const user = users.find(u => u.id === id);

  if (!user) {
    return { status: 404, body: { error: 'User not found' } };
  }

  return user;
};

// PUT /api/users/:id
export const PUT = async (req: ZapRequest) => {
  const { id } = req.params;
  const updates = JSON.parse(req.body);

  const index = users.findIndex(u => u.id === id);
  if (index === -1) {
    return { status: 404, body: { error: 'User not found' } };
  }

  users[index] = { ...users[index], ...updates };
  return users[index];
};

// DELETE /api/users/:id
export const DELETE = async (req: ZapRequest) => {
  const { id } = req.params;

  const index = users.findIndex(u => u.id === id);
  if (index === -1) {
    return { status: 404, body: { error: 'User not found' } };
  }

  users.splice(index, 1);
  return { status: 204 };
};
```

### Authentication Check

```typescript
const requireAuth = (req: ZapRequest) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return { authorized: false, error: 'No token provided' };
  }

  try {
    const user = verifyToken(token);
    return { authorized: true, user };
  } catch {
    return { authorized: false, error: 'Invalid token' };
  }
};

export const GET = async (req: ZapRequest) => {
  const auth = requireAuth(req);

  if (!auth.authorized) {
    return {
      status: 401,
      body: { error: auth.error },
    };
  }

  return { user: auth.user };
};
```

### File Upload (Form Data)

```typescript
export const POST = async (req: ZapRequest) => {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    // Parse multipart form data
    // (Implementation depends on your parsing library)
    return { status: 501, body: { error: 'Not implemented' } };
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(req.body);
    return {
      name: form.get('name'),
      email: form.get('email'),
    };
  }

  return { status: 415, body: { error: 'Unsupported content type' } };
};
```

### Pagination

```typescript
export const GET = async (req: ZapRequest) => {
  const page = parseInt(req.query.page || '1');
  const limit = parseInt(req.query.limit || '20');
  const offset = (page - 1) * limit;

  const [items, total] = await Promise.all([
    db.items.findMany({ skip: offset, take: limit }),
    db.items.count(),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};
```

## Zaptest Examples

From the zaptest application:

**`routes/api/hello.ts`**

```typescript
export const GET = async () => {
  return {
    message: 'Hello from ZapJS!',
    timestamp: new Date().toISOString(),
  };
};

export const POST = async ({ body }: { body: string }) => {
  const data = JSON.parse(body);
  return {
    received: data,
    message: 'Data received successfully',
  };
};
```

**`routes/api/users.$id.ts`**

```typescript
export const GET = async (req: ZapRequest) => {
  const { id } = req.params;

  return {
    id: parseInt(id),
    name: `User ${id}`,
    email: `user${id}@example.com`,
    createdAt: new Date().toISOString(),
  };
};

export const PUT = async (req: ZapRequest) => {
  const { id } = req.params;
  const body = JSON.parse(req.body);

  return {
    id: parseInt(id),
    ...body,
    updatedAt: new Date().toISOString(),
  };
};

export const DELETE = async (req: ZapRequest) => {
  const { id } = req.params;

  return {
    deleted: true,
    id: parseInt(id),
  };
};
```

---

## See Also

- [File Routing Guide](./file-routing.md) - Route patterns
- [Server Functions Guide](./server-functions.md) - Rust RPC
- [Router API](../api/router.md) - Programmatic API
