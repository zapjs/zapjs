# zap-macros

The `zap-macros` crate provides the `#[zap::export]` procedural macro for exposing Rust functions to TypeScript with automatic type conversion.

## Overview

```
zap-macros/
├── lib.rs          # Macro definition
├── types.rs        # Type parsing and conversion
└── metadata.rs     # Function metadata extraction
```

## The #[zap::export] Macro

Marks a function for export to TypeScript, generating:
1. A JSON-serializing wrapper function
2. Compile-time metadata for codegen

### Basic Usage

```rust
use zap_macros::export;

#[zap::export]
pub async fn get_user(id: u64) -> Result<User, Error> {
    // Your implementation
    Ok(User { id, name: "John".to_string() })
}

#[zap::export]
pub fn add_numbers(a: i32, b: i32) -> i32 {
    a + b
}
```

### Generated Code

For each exported function, the macro generates:

```rust
// Original function (unchanged)
pub async fn get_user(id: u64) -> Result<User, Error> {
    Ok(User { id, name: "John".to_string() })
}

// Generated wrapper
#[doc(hidden)]
pub async fn __zap_wrapper_get_user(
    params: &HashMap<String, serde_json::Value>
) -> Result<serde_json::Value, String> {
    // Extract and deserialize parameters
    let id: u64 = serde_json::from_value(
        params.get("id")
            .ok_or("Missing parameter: id")?
            .clone()
    ).map_err(|e| format!("Failed to parse 'id': {}", e))?;

    // Call original function
    let result = get_user(id).await
        .map_err(|e| format!("Handler error: {}", e))?;

    // Serialize result
    serde_json::to_value(result)
        .map_err(|e| format!("Serialization error: {}", e))
}

// Metadata constant (for codegen)
#[doc(hidden)]
pub const __ZAP_EXPORT_GET_USER: &str = r#"{
    "name": "get_user",
    "params": [{"name": "id", "type": "u64", "optional": false}],
    "return_type": {"Result": {"ok": "User", "err": "Error"}},
    "is_async": true
}"#;
```

## Type Mapping

### Primitive Types

| Rust Type | TypeScript Type |
|-----------|-----------------|
| `String` | `string` |
| `&str` | `string` |
| `bool` | `boolean` |
| `i8`, `i16`, `i32`, `i64`, `i128` | `number` |
| `u8`, `u16`, `u32`, `u64`, `u128` | `number` |
| `f32`, `f64` | `number` |
| `()` | `void` |

### Collection Types

| Rust Type | TypeScript Type |
|-----------|-----------------|
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` |
| `HashMap<K, V>` | `Record<K, V>` |
| `BTreeMap<K, V>` | `Record<K, V>` |
| `HashSet<T>` | `T[]` |

### Result Types

| Rust Type | TypeScript Type |
|-----------|-----------------|
| `Result<T, E>` | `Promise<T>` (errors throw) |

### Custom Types

Custom structs and enums are passed through by name. Ensure they implement `Serialize` and `Deserialize`:

```rust
#[derive(Serialize, Deserialize)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub email: Option<String>,
}

// Generates TypeScript:
// interface User {
//     id: number;
//     name: string;
//     email: string | null;
// }
```

## Function Requirements

### Must Have

- `pub` visibility
- Named parameters (not patterns)
- Serializable parameter types
- Serializable return type

### Supported

- `async fn` and regular `fn`
- `Result<T, E>` return types
- Optional parameters via `Option<T>`
- Generic type parameters (limited)

### Not Supported

- `self` parameters (methods)
- References in parameters (`&T`)
- Lifetime parameters
- `impl Trait` in parameters
- Variadic arguments

## Namespace Convention

Functions are automatically namespaced based on their location:

```rust
// src/handlers/users.rs
#[zap::export]
pub async fn get(id: u64) -> User { ... }

#[zap::export]
pub async fn list(page: u32) -> Vec<User> { ... }

// Generates:
// server.users.get({ id: 123 })
// server.users.list({ page: 1 })
```

The namespace is derived from:
1. Module path relative to `src/`
2. File name (excluding `mod.rs`)

## Metadata Extraction

### TypeMetadata Enum

```rust
pub enum TypeMetadata {
    String,
    Bool,
    I8, I16, I32, I64, I128,
    U8, U16, U32, U64, U128,
    F32, F64,
    Option(Box<TypeMetadata>),
    Vec(Box<TypeMetadata>),
    HashMap {
        key: Box<TypeMetadata>,
        value: Box<TypeMetadata>,
    },
    Custom {
        name: String,
        generics: Vec<TypeMetadata>,
    },
    Unit,
    Result {
        ok: Box<TypeMetadata>,
        err: Box<TypeMetadata>,
    },
}
```

### FunctionMetadata

```rust
pub struct FunctionMetadata {
    pub name: String,
    pub params: Vec<ParamMetadata>,
    pub return_type: TypeMetadata,
    pub is_async: bool,
    pub doc_comments: Vec<String>,
    pub line_number: usize,
}

pub struct ParamMetadata {
    pub name: String,
    pub ty: TypeMetadata,
    pub is_optional: bool,
}
```

## Examples

### Simple Function

```rust
#[zap::export]
pub fn greet(name: String) -> String {
    format!("Hello, {}!", name)
}

// TypeScript:
// function greet(name: string): Promise<string>
```

### Async with Result

```rust
#[zap::export]
pub async fn fetch_user(id: u64) -> Result<User, DbError> {
    db.find_user(id).await
}

// TypeScript:
// async function fetchUser(id: number): Promise<User>
// Throws on error
```

### Optional Parameters

```rust
#[zap::export]
pub fn search_users(
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Vec<User> {
    let limit = limit.unwrap_or(10);
    let offset = offset.unwrap_or(0);
    // ...
}

// TypeScript:
// function searchUsers(params: {
//     query: string;
//     limit?: number;
//     offset?: number;
// }): Promise<User[]>
```

### Complex Types

```rust
#[derive(Serialize, Deserialize)]
pub struct CreateUserRequest {
    pub name: String,
    pub email: String,
    pub roles: Vec<String>,
    pub metadata: Option<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
pub struct CreateUserResponse {
    pub id: u64,
    pub created_at: String,
}

#[zap::export]
pub async fn create_user(
    request: CreateUserRequest
) -> Result<CreateUserResponse, ValidationError> {
    // ...
}

// TypeScript:
// interface CreateUserRequest {
//     name: string;
//     email: string;
//     roles: string[];
//     metadata?: Record<string, string>;
// }
//
// interface CreateUserResponse {
//     id: number;
//     created_at: string;
// }
//
// async function createUser(
//     request: CreateUserRequest
// ): Promise<CreateUserResponse>
```

## Error Handling

Errors in exported functions become TypeScript exceptions:

```rust
#[zap::export]
pub async fn get_user(id: u64) -> Result<User, String> {
    if id == 0 {
        return Err("Invalid user ID".to_string());
    }
    // ...
}
```

```typescript
try {
    const user = await server.users.get({ id: 0 });
} catch (error) {
    console.error(error.message); // "Invalid user ID"
}
```

## Compilation

The macro runs at compile time using the `syn` and `quote` crates:

```toml
[dependencies]
syn = { version = "2.0", features = ["full", "parsing"] }
quote = "1.0"
proc-macro2 = "1.0"
```

---

## See Also

- [zap-codegen](./zap-codegen.md) - TypeScript generation from metadata
- [Server Functions Guide](../guides/server-functions.md) - Usage guide
- [Architecture](../ARCHITECTURE.md) - System design
