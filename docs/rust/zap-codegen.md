# zap-codegen

The `zap-codegen` crate generates TypeScript bindings from Rust functions marked with `#[zap::export]`. It creates type-safe client code for calling Rust handlers from TypeScript.

## Overview

```
zap-codegen/
├── main.rs         # CLI entry point
├── lib.rs          # Code generation logic
├── types.rs        # Type conversion
└── metadata.rs     # Metadata structures
```

## CLI Usage

```bash
zap-codegen [OPTIONS]

Options:
    --project-dir <PATH>    Cargo project directory (default: .)
    --output-dir <PATH>     TypeScript output directory (default: ./src/api)
    --input <PATH>          JSON metadata file (optional)
    --definitions           Generate .d.ts files (default: true)
    --runtime               Generate .ts files (default: true)
    --server                Generate namespaced server client (default: true)
```

### Examples

```bash
# Generate all bindings
zap-codegen --project-dir ./server --output-dir ./src/generated

# Only type definitions
zap-codegen --definitions --no-runtime --no-server

# From explicit metadata file
zap-codegen --input ./exports.json --output-dir ./src/api
```

## Generated Files

### server.ts (Namespaced Client)

The primary generated file providing a namespaced API:

```typescript
// src/generated/server.ts

import { rpcCall } from '@zapjs/runtime';

export const server = {
  users: {
    async get(params: { id: number }): Promise<User> {
      return rpcCall<User>('users.get', { id: params.id });
    },

    async list(params: { page?: number; limit?: number }): Promise<User[]> {
      return rpcCall<User[]>('users.list', {
        page: params.page,
        limit: params.limit,
      });
    },

    async create(params: { request: CreateUserRequest }): Promise<User> {
      return rpcCall<User>('users.create', { request: params.request });
    },
  },

  posts: {
    async get(params: { id: number }): Promise<Post> {
      return rpcCall<Post>('posts.get', { id: params.id });
    },

    async list(params: { userId?: number }): Promise<Post[]> {
      return rpcCall<Post[]>('posts.list', { userId: params.userId });
    },
  },
} as const;

export type Server = typeof server;
```

### backend.ts (Flat Exports)

Alternative flat export style:

```typescript
// src/generated/backend.ts

import { rpcCall } from '@zapjs/runtime';

export async function getUser(id: number): Promise<User> {
  return rpcCall('get_user', { id });
}

export async function listUsers(page?: number, limit?: number): Promise<User[]> {
  return rpcCall('list_users', { page, limit });
}

export async function createUser(request: CreateUserRequest): Promise<User> {
  return rpcCall('create_user', { request });
}

export const backend = {
  getUser,
  listUsers,
  createUser,
};
```

### backend.d.ts (Type Definitions)

TypeScript declaration file:

```typescript
// src/generated/backend.d.ts

export interface User {
  id: number;
  name: string;
  email: string | null;
  createdAt: string;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  roles: string[];
}

export interface Post {
  id: number;
  title: string;
  content: string;
  authorId: number;
}

export interface ZapBackend {
  getUser(id: number): Promise<User>;
  listUsers(page?: number, limit?: number): Promise<User[]>;
  createUser(request: CreateUserRequest): Promise<User>;
  getPost(id: number): Promise<Post>;
  listPosts(userId?: number): Promise<Post[]>;
}

export declare const backend: ZapBackend;

export declare function getUser(id: number): Promise<User>;
export declare function listUsers(page?: number, limit?: number): Promise<User[]>;
export declare function createUser(request: CreateUserRequest): Promise<User>;
```

## Type Conversion

### Rust to TypeScript

| Rust | TypeScript |
|------|------------|
| `String`, `&str` | `string` |
| `bool` | `boolean` |
| `i8`-`i128`, `u8`-`u128` | `number` |
| `f32`, `f64` | `number` |
| `()` | `void` |
| `Option<T>` | `T \| null` |
| `Vec<T>` | `T[]` |
| `HashMap<K, V>` | `Record<K, V>` |
| `Result<T, E>` | `Promise<T>` |
| Custom struct | Interface |

### Name Conversion

- Function names: `snake_case` → `camelCase`
- Parameter names: `snake_case` → `camelCase`
- Type names: Preserved (PascalCase)

```rust
pub async fn get_user_by_email(user_email: String) -> User { ... }

// Becomes:
async function getUserByEmail(userEmail: string): Promise<User>
```

## Namespace Grouping

Functions are grouped by namespace derived from module path:

```rust
// src/handlers/users.rs
#[zap::export]
pub async fn get(id: u64) -> User { ... }

// src/handlers/posts.rs
#[zap::export]
pub async fn get(id: u64) -> Post { ... }
```

Generates:

```typescript
export const server = {
  users: {
    async get(params: { id: number }): Promise<User> { ... }
  },
  posts: {
    async get(params: { id: number }): Promise<Post> { ... }
  },
};
```

## API Reference

### ExportedFunction

```rust
pub struct ExportedFunction {
    /// Function name (snake_case)
    pub name: String,

    /// Optional namespace (e.g., "users", "posts")
    pub namespace: Option<String>,

    /// Whether function is async
    pub is_async: bool,

    /// Function parameters
    pub params: Vec<ExportedParam>,

    /// Return type
    pub return_type: ExportedType,

    /// Doc comments from Rust
    pub doc_comments: Vec<String>,
}
```

### ExportedParam

```rust
pub struct ExportedParam {
    /// Parameter name (snake_case)
    pub name: String,

    /// Parameter type
    pub ty: ExportedType,

    /// Whether parameter is optional (Option<T>)
    pub is_optional: bool,
}
```

### ExportedType

```rust
pub enum ExportedType {
    String,
    Bool,
    I8, I16, I32, I64, I128,
    U8, U16, U32, U64, U128,
    F32, F64,
    Option(Box<ExportedType>),
    Vec(Box<ExportedType>),
    HashMap {
        key: Box<ExportedType>,
        value: Box<ExportedType>,
    },
    Custom {
        name: String,
        generics: Vec<ExportedType>,
    },
    Unit,
    Result {
        ok: Box<ExportedType>,
        err: Box<ExportedType>,
    },
}
```

### Generation Functions

```rust
/// Generate TypeScript type definitions (.d.ts)
pub fn generate_typescript_definitions(
    functions: &[ExportedFunction]
) -> String;

/// Generate TypeScript runtime bindings (.ts)
pub fn generate_typescript_runtime(
    functions: &[ExportedFunction]
) -> String;

/// Generate namespaced server client
pub fn generate_namespaced_server(
    functions: &[ExportedFunction]
) -> String;

/// Group functions by namespace
pub fn group_by_namespace(
    functions: &[ExportedFunction]
) -> HashMap<String, Vec<&ExportedFunction>>;

/// Find exported functions in project
pub fn find_exported_functions(
    project_dir: &str
) -> Result<Vec<ExportedFunction>, Error>;
```

## Metadata JSON Format

When using `--input`, provide a JSON file:

```json
{
  "functions": [
    {
      "name": "get_user",
      "namespace": "users",
      "is_async": true,
      "params": [
        {
          "name": "id",
          "type": "u64",
          "optional": false
        }
      ],
      "return_type": {
        "Result": {
          "ok": { "Custom": { "name": "User", "generics": [] } },
          "err": "String"
        }
      },
      "doc_comments": ["Fetch a user by ID"]
    }
  ],
  "types": [
    {
      "name": "User",
      "fields": [
        { "name": "id", "type": "u64" },
        { "name": "name", "type": "String" },
        { "name": "email", "type": { "Option": "String" } }
      ]
    }
  ]
}
```

## Integration with Build Pipeline

### Development Mode

The `@zapjs/dev-server` runs codegen automatically:

```typescript
// packages/dev-server/src/codegen-runner.ts
class CodegenRunner {
  async run() {
    await exec(`zap-codegen --project-dir ${projectDir} --output-dir ${outputDir}`);
  }
}
```

### Production Build

The `zap build` command includes codegen:

```bash
# Part of zap build
zap-codegen --project-dir ./server --output-dir ./src/generated
```

### Watch Mode

Codegen runs on Rust file changes:

```typescript
watcher.on('change', async (path) => {
  if (path.endsWith('.rs')) {
    await rustBuilder.build();
    await codegenRunner.run();  // Regenerate bindings
  }
});
```

## Example Workflow

### 1. Write Rust Functions

```rust
// server/src/handlers/users.rs

#[zap::export]
pub async fn get(id: u64) -> Result<User, DbError> {
    db.find_user(id).await
}

#[zap::export]
pub async fn create(request: CreateUserRequest) -> Result<User, ValidationError> {
    validate(&request)?;
    db.create_user(request).await
}
```

### 2. Run Codegen

```bash
zap codegen
# or automatically via `zap dev`
```

### 3. Use in TypeScript

```typescript
import { server } from './generated/server';

// Type-safe calls
const user = await server.users.get({ id: 123 });
console.log(user.name);

const newUser = await server.users.create({
  request: {
    name: 'Alice',
    email: 'alice@example.com',
    roles: ['user'],
  },
});
```

---

## See Also

- [zap-macros](./zap-macros.md) - Export macro
- [Server Functions Guide](../guides/server-functions.md) - Usage patterns
- [Build Pipeline](../internals/build-pipeline.md) - Build system
