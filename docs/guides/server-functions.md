# Server Functions

Server functions let you call Rust code from TypeScript with full type safety. This guide covers the `#[zap::export]` macro and the generated TypeScript client.

## Overview

1. Mark Rust functions with `#[zap::export]`
2. Run codegen to generate TypeScript bindings
3. Import and call from TypeScript with full types

## Writing Server Functions

### Basic Function

```rust
// server/src/handlers.rs

use zap_macros::export;

#[zap::export]
pub fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}
```

### Async Function

```rust
#[zap::export]
pub async fn get_user(id: u64) -> Result<User, DbError> {
    let user = db::find_user(id).await?;
    Ok(user)
}
```

### With Custom Types

```rust
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub email: String,
}

#[derive(Serialize, Deserialize)]
pub struct CreateUserRequest {
    pub name: String,
    pub email: String,
}

#[zap::export]
pub async fn create_user(request: CreateUserRequest) -> Result<User, ValidationError> {
    // Validate
    if request.name.is_empty() {
        return Err(ValidationError::new("Name is required"));
    }

    // Create
    let user = db::create_user(&request).await?;
    Ok(user)
}
```

## Generated TypeScript

### Namespaced Client

The primary interface is the `server` object:

```typescript
// src/generated/server.ts

export const server = {
  // Functions are grouped by namespace
  users: {
    async get(params: { id: number }): Promise<User> {
      return rpcCall<User>('users.get', { id: params.id });
    },

    async create(params: { request: CreateUserRequest }): Promise<User> {
      return rpcCall<User>('users.create', { request: params.request });
    },

    async list(params: { page?: number; limit?: number }): Promise<User[]> {
      return rpcCall<User[]>('users.list', {
        page: params.page,
        limit: params.limit,
      });
    },
  },

  posts: {
    async get(params: { id: number }): Promise<Post> {
      return rpcCall<Post>('posts.get', { id: params.id });
    },
  },
} as const;
```

### Type Definitions

```typescript
// src/generated/backend.d.ts

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface CreateUserRequest {
  name: string;
  email: string;
}
```

## Using in TypeScript

### Basic Calls

```typescript
import { server } from './generated/server';

// Simple call
const user = await server.users.get({ id: 123 });
console.log(user.name);

// With multiple params
const users = await server.users.list({ page: 1, limit: 20 });

// Create
const newUser = await server.users.create({
  request: {
    name: 'Alice',
    email: 'alice@example.com',
  },
});
```

### Error Handling

Errors from Rust throw as exceptions:

```typescript
try {
  const user = await server.users.get({ id: 999 });
} catch (error) {
  if (error.message.includes('not found')) {
    console.log('User not found');
  } else {
    throw error;
  }
}
```

### In React Components

```tsx
import { useState, useEffect } from 'react';
import { server } from './generated/server';

function UserProfile({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    server.users.get({ id: userId })
      .then(setUser)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!user) return <div>User not found</div>;

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  );
}
```

## Type Mapping

### Primitives

| Rust | TypeScript |
|------|------------|
| `String`, `&str` | `string` |
| `bool` | `boolean` |
| `i8` - `i128` | `number` |
| `u8` - `u128` | `number` |
| `f32`, `f64` | `number` |
| `()` | `void` |

### Collections

| Rust | TypeScript |
|------|------------|
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` |
| `HashMap<K, V>` | `Record<K, V>` |
| `Result<T, E>` | `Promise<T>` |

### Custom Types

Structs and enums convert to interfaces:

```rust
#[derive(Serialize, Deserialize)]
pub struct Post {
    pub id: u64,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub published_at: Option<String>,
}
```

```typescript
interface Post {
  id: number;
  title: string;
  content: string;
  tags: string[];
  published_at: string | null;
}
```

## Namespacing

Functions are namespaced by their module path:

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
server.users.get({ id: 1 })  // Users handler
server.posts.get({ id: 1 })  // Posts handler
```

## Running Codegen

### Via CLI

```bash
# Generate bindings
zap codegen

# Custom output
zap codegen --output ./src/api
```

### Via Dev Server

Codegen runs automatically when:
- Starting `zap dev`
- Rust files change (in watch mode)

### Manual in Script

```typescript
import { exec } from 'child_process';

exec('zap-codegen --project-dir ./server --output-dir ./src/generated');
```

## Best Practices

### 1. Group Related Functions

```rust
// Good: Organized by domain
mod users {
    #[zap::export]
    pub async fn get(id: u64) -> User { ... }

    #[zap::export]
    pub async fn list(page: u32) -> Vec<User> { ... }

    #[zap::export]
    pub async fn create(req: CreateUserRequest) -> User { ... }
}
```

### 2. Use Request/Response Types

```rust
// Good: Clear input/output types
#[derive(Serialize, Deserialize)]
pub struct SearchUsersRequest {
    pub query: String,
    pub filters: Option<UserFilters>,
    pub page: Option<u32>,
}

#[derive(Serialize, Deserialize)]
pub struct SearchUsersResponse {
    pub users: Vec<User>,
    pub total: u64,
    pub page: u32,
}

#[zap::export]
pub async fn search(request: SearchUsersRequest) -> SearchUsersResponse { ... }
```

### 3. Handle Errors Gracefully

```rust
use thiserror::Error;

#[derive(Error, Debug, Serialize)]
pub enum UserError {
    #[error("User not found")]
    NotFound,

    #[error("Validation failed: {0}")]
    Validation(String),

    #[error("Database error")]
    Database,
}

#[zap::export]
pub async fn get_user(id: u64) -> Result<User, UserError> {
    let user = db::find_user(id).await
        .map_err(|_| UserError::Database)?
        .ok_or(UserError::NotFound)?;

    Ok(user)
}
```

### 4. Keep Functions Focused

```rust
// Good: Single responsibility
#[zap::export]
pub async fn get_user(id: u64) -> User { ... }

#[zap::export]
pub async fn get_user_posts(user_id: u64) -> Vec<Post> { ... }

// Avoid: Multiple responsibilities
#[zap::export]
pub async fn get_user_with_posts_and_comments(id: u64) -> UserWithEverything { ... }
```

## Complete Example

### Rust Side

```rust
// server/src/lib.rs

use zap_macros::export;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: u64,
    pub title: String,
    pub completed: bool,
}

#[derive(Serialize, Deserialize)]
pub struct CreateTodoRequest {
    pub title: String,
}

static mut TODOS: Vec<Todo> = Vec::new();
static mut NEXT_ID: u64 = 1;

#[zap::export]
pub fn list_todos() -> Vec<Todo> {
    unsafe { TODOS.clone() }
}

#[zap::export]
pub fn get_todo(id: u64) -> Result<Todo, String> {
    unsafe {
        TODOS.iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| format!("Todo {} not found", id))
    }
}

#[zap::export]
pub fn create_todo(request: CreateTodoRequest) -> Todo {
    unsafe {
        let todo = Todo {
            id: NEXT_ID,
            title: request.title,
            completed: false,
        };
        NEXT_ID += 1;
        TODOS.push(todo.clone());
        todo
    }
}

#[zap::export]
pub fn toggle_todo(id: u64) -> Result<Todo, String> {
    unsafe {
        let todo = TODOS.iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Todo {} not found", id))?;

        todo.completed = !todo.completed;
        Ok(todo.clone())
    }
}

#[zap::export]
pub fn delete_todo(id: u64) -> Result<(), String> {
    unsafe {
        let index = TODOS.iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("Todo {} not found", id))?;

        TODOS.remove(index);
        Ok(())
    }
}
```

### TypeScript Side

```tsx
// src/components/TodoApp.tsx

import { useState, useEffect } from 'react';
import { server } from '../generated/server';

export function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    server.todos.list({}).then(setTodos);
  }, []);

  const addTodo = async () => {
    if (!newTitle.trim()) return;

    const todo = await server.todos.create({
      request: { title: newTitle },
    });

    setTodos([...todos, todo]);
    setNewTitle('');
  };

  const toggleTodo = async (id: number) => {
    const updated = await server.todos.toggle({ id });
    setTodos(todos.map(t => t.id === id ? updated : t));
  };

  const deleteTodo = async (id: number) => {
    await server.todos.delete({ id });
    setTodos(todos.filter(t => t.id !== id));
  };

  return (
    <div>
      <h1>Todo App</h1>

      <div>
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="What needs to be done?"
        />
        <button onClick={addTodo}>Add</button>
      </div>

      <ul>
        {todos.map(todo => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id)}
            />
            <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
              {todo.title}
            </span>
            <button onClick={() => deleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## See Also

- [zap-macros](../rust/zap-macros.md) - Macro documentation
- [zap-codegen](../rust/zap-codegen.md) - Codegen documentation
- [Architecture](../ARCHITECTURE.md) - System design
