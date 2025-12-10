# zap-core

The `zap-core` crate provides the foundational HTTP primitives for the Zap.js framework. It implements zero-copy HTTP parsing, a high-performance radix tree router, and a composable middleware system.

## Overview

```
zap-core/
├── lib.rs          # Public exports
├── router.rs       # Router<T> - HTTP method routing
├── radix.rs        # RadixTree<T> - Path matching
├── method.rs       # Method enum - HTTP methods
├── params.rs       # Params<'a> - Route parameters
├── http.rs         # HttpParser - Request parsing
├── request.rs      # Request<'a> - Request abstraction
├── response.rs     # Response - Response builder
├── middleware.rs   # Middleware system
└── headers.rs      # Headers<'a> - Header access
```

## Router

The `Router<T>` struct provides HTTP method-aware routing with handler storage.

### Usage

```rust
use zap_core::{Router, Method};

let mut router = Router::new();

// Register routes
router.insert(Method::GET, "/users", get_users_handler);
router.insert(Method::GET, "/users/:id", get_user_handler);
router.insert(Method::POST, "/users", create_user_handler);
router.insert(Method::DELETE, "/users/:id", delete_user_handler);

// Match requests
if let Some((handler, params)) = router.at(Method::GET, "/users/123") {
    let user_id = params.get("id"); // Some("123")
    // Execute handler
}
```

### API

```rust
impl<T> Router<T> {
    /// Create a new router
    pub fn new() -> Self;

    /// Insert a route handler
    pub fn insert(&mut self, method: Method, path: &str, handler: T);

    /// Find a handler for the given method and path
    pub fn at(&self, method: Method, path: &str) -> Option<(&T, Params<'_>)>;

    /// Get number of routes for a specific method
    pub fn len(&self, method: Method) -> usize;

    /// Check if router is empty
    pub fn is_empty(&self) -> bool;

    /// Get total routes across all methods
    pub fn total_routes(&self) -> usize;

    /// Iterate over all registered methods
    pub fn methods(&self) -> impl Iterator<Item = Method>;
}
```

## Method

HTTP method enumeration with SIMD-optimized parsing.

### Variants

```rust
pub enum Method {
    GET = 0,
    POST = 1,
    PUT = 2,
    DELETE = 3,
    PATCH = 4,
    HEAD = 5,
    OPTIONS = 6,
    CONNECT = 7,
    TRACE = 8,
}
```

### API

```rust
impl Method {
    /// Parse method from bytes (SIMD-optimized)
    pub fn from_bytes(bytes: &[u8]) -> Option<Self>;

    /// Get method as string slice
    pub fn as_str(&self) -> &'static str;

    /// Check if method has no side effects
    pub fn is_safe(&self) -> bool;  // GET, HEAD, OPTIONS

    /// Check if method is idempotent
    pub fn is_idempotent(&self) -> bool;  // GET, HEAD, PUT, DELETE, OPTIONS
}
```

## Params

Zero-copy route parameter extraction.

### Usage

```rust
use zap_core::Params;

// Created during route matching
let params: Params<'_> = /* from router.at() */;

// Access parameters
let id = params.get("id");           // Option<&str>
let id: u64 = params.parse("id")?;   // Parse as type
let uuid = params.get_uuid("id")?;   // Parse as UUID

// Iteration
for (key, value) in params.iter() {
    println!("{}: {}", key, value);
}
```

### API

```rust
impl<'a> Params<'a> {
    /// Create empty params
    pub fn new() -> Self;

    /// Create with pre-allocated capacity
    pub fn with_capacity(capacity: usize) -> Self;

    /// Get parameter by name
    pub fn get(&self, name: &str) -> Option<&'a str>;

    /// Parse parameter as type T
    pub fn parse<T: FromStr>(&self, name: &str) -> Result<T, ParseError>;

    /// Get parameter as u64
    pub fn get_u64(&self, name: &str) -> Result<u64, ParseError>;

    /// Get parameter as i64
    pub fn get_i64(&self, name: &str) -> Result<i64, ParseError>;

    /// Get parameter as UUID
    pub fn get_uuid(&self, name: &str) -> Result<Uuid, ParseError>;

    /// Iterate over all parameters
    pub fn iter(&self) -> impl Iterator<Item = (&'a str, &'a str)>;

    /// Check if parameter exists
    pub fn contains(&self, name: &str) -> bool;

    /// Number of parameters
    pub fn len(&self) -> usize;

    /// Check if empty
    pub fn is_empty(&self) -> bool;
}
```

## RadixTree

The radix tree provides ultra-fast path matching with support for:

- Static paths: `/users`
- Parameter paths: `/users/:id`
- Wildcard paths: `/files/*filepath`
- Catch-all paths: `/posts/**catchall`

### Performance

| Path Type | Lookup Time |
|-----------|-------------|
| Static | ~9ns |
| Single param | ~40ns |
| Multi param | ~80ns |
| Wildcard | ~60ns |

### Usage

```rust
use zap_core::RadixTree;

let mut tree = RadixTree::new();

tree.insert("/", root_handler);
tree.insert("/users", list_users);
tree.insert("/users/:id", get_user);
tree.insert("/users/:id/posts", get_user_posts);
tree.insert("/files/*path", serve_file);

// Matching
if let Some((handler, params)) = tree.find("/users/123/posts") {
    // params.get("id") == Some("123")
}
```

## HttpParser

Zero-copy HTTP/1.1 request parser.

### Usage

```rust
use zap_core::HttpParser;

let parser = HttpParser::new();
let request_bytes = b"GET /users?page=1 HTTP/1.1\r\nHost: localhost\r\n\r\n";

match parser.parse_request(request_bytes) {
    Ok(parsed) => {
        println!("Method: {:?}", parsed.method);
        println!("Path: {}", parsed.path);
        println!("Host: {:?}", parsed.headers.get("host"));
    }
    Err(e) => eprintln!("Parse error: {}", e),
}
```

### ParsedRequest

```rust
pub struct ParsedRequest<'a> {
    pub method: Method,
    pub path: &'a str,          // Full path with query string
    pub version: &'a str,       // "HTTP/1.1"
    pub headers: Headers<'a>,
    pub body_offset: usize,     // Where body starts in buffer
    pub total_size: usize,      // Total parsed bytes
}
```

### API

```rust
impl HttpParser {
    /// Create parser with default limits
    pub fn new() -> Self;

    /// Create with custom limits
    pub fn with_limits(max_header_size: usize, max_headers: usize) -> Self;

    /// Parse HTTP request (zero-copy)
    pub fn parse_request<'a>(&self, input: &'a [u8]) -> Result<ParsedRequest<'a>, ParseError>;
}
```

## Headers

Zero-copy header access with case-insensitive lookups.

### Usage

```rust
let headers: Headers<'_> = parsed_request.headers;

// Get header value
let content_type = headers.get("content-type");
let host = headers.get("Host");  // Case-insensitive

// Parse typed header
let length: usize = headers.get_parsed("content-length")?;

// Convenience methods
let content_length = headers.content_length();
let keep_alive = headers.keep_alive();
```

### API

```rust
impl<'a> Headers<'a> {
    /// Get header value (case-insensitive)
    pub fn get(&self, name: &str) -> Option<&'a str>;

    /// Parse header as type T
    pub fn get_parsed<T: FromStr>(&self, name: &str) -> Result<T, ParseError>;

    /// Get Content-Length
    pub fn content_length(&self) -> Option<usize>;

    /// Check if connection should be kept alive
    pub fn keep_alive(&self) -> bool;

    /// Iterate over all headers
    pub fn iter(&self) -> impl Iterator<Item = (&'a str, &'a str)>;

    /// Number of headers
    pub fn count(&self) -> usize;
}
```

## Request

High-level request abstraction combining parsed data with parameters.

### Usage

```rust
use zap_core::Request;

fn handle_request(req: Request<'_>) {
    // Request metadata
    let method = req.method();
    let path = req.path();
    let path_only = req.path_only();  // Without query string

    // Headers
    let content_type = req.content_type();
    let user_agent = req.user_agent();
    let host = req.host();

    // Route parameters
    let id = req.param("id");

    // Query string
    let query = req.query_params();
    let page = query.get("page");

    // Body
    let body = req.body();
    let body_str = req.body_string();

    // Cookies
    let session = req.cookie("session_id");

    // Client IP (from X-Forwarded-For or X-Real-IP)
    let ip = req.remote_ip();

    // Form data
    if req.content_type() == Some("application/x-www-form-urlencoded") {
        let form = req.form_data();
    }
}
```

## Response

Response builder with fluent API.

### Usage

```rust
use zap_core::{Response, StatusCode};

// Simple response
let response = Response::new()
    .status(StatusCode::OK)
    .header("Content-Type", "application/json")
    .body(r#"{"status":"ok"}"#);

// Convenience methods
let not_found = Response::not_found("Resource not found");
let redirect = Response::redirect("/login");
let error = Response::internal_server_error("Something went wrong");

// With cookies
let response = Response::new()
    .status(StatusCode::OK)
    .cookie("session", "abc123")
    .cookie_with_options("remember", "true", CookieOptions {
        http_only: true,
        secure: true,
        same_site: SameSite::Strict,
        max_age: Some(Duration::days(30)),
        ..Default::default()
    })
    .text("Logged in");

// Generate HTTP bytes
let wire_bytes = response.to_wire_format();
```

### StatusCode

```rust
impl StatusCode {
    // Common status codes
    pub const OK: StatusCode = StatusCode(200);
    pub const CREATED: StatusCode = StatusCode(201);
    pub const NO_CONTENT: StatusCode = StatusCode(204);
    pub const MOVED_PERMANENTLY: StatusCode = StatusCode(301);
    pub const FOUND: StatusCode = StatusCode(302);
    pub const BAD_REQUEST: StatusCode = StatusCode(400);
    pub const UNAUTHORIZED: StatusCode = StatusCode(401);
    pub const FORBIDDEN: StatusCode = StatusCode(403);
    pub const NOT_FOUND: StatusCode = StatusCode(404);
    pub const INTERNAL_SERVER_ERROR: StatusCode = StatusCode(500);

    pub fn new(code: u16) -> Self;
    pub fn as_u16(&self) -> u16;
    pub fn is_success(&self) -> bool;
    pub fn is_client_error(&self) -> bool;
    pub fn is_server_error(&self) -> bool;
    pub fn canonical_reason(&self) -> &'static str;
}
```

## Middleware

Composable middleware system with zero-allocation where possible.

### Usage

```rust
use zap_core::{MiddlewareChain, Context, Middleware};

// Create middleware chain
let mut chain = MiddlewareChain::new();
chain.use_middleware(LoggerMiddleware::new());
chain.use_middleware(CorsMiddleware::permissive());

// Execute chain
let response = chain.execute(context).await;
```

### Context

```rust
pub struct Context<'a> {
    pub request: &'a ParsedRequest<'a>,
    pub body: &'a [u8],
    pub response: ResponseBuilder,
    pub extensions: Extensions,  // Type-safe state storage
}

impl<'a> Context<'a> {
    pub fn method(&self) -> Method;
    pub fn path(&self) -> &str;
    pub fn headers(&self) -> &Headers<'a>;
    pub fn body(&self) -> &[u8];
    pub fn body_string(&self) -> Result<&str, Utf8Error>;
}
```

### Built-in Middleware

```rust
// Logging middleware
let logger = LoggerMiddleware::new();

// CORS middleware
let cors = CorsMiddleware::permissive();  // Allow all origins
let cors = CorsMiddleware::new()
    .allow_origin("https://example.com")
    .allow_methods(&[Method::GET, Method::POST])
    .allow_headers(&["Content-Type", "Authorization"])
    .max_age(3600);
```

### Custom Middleware

```rust
use zap_core::{Middleware, Context};

struct AuthMiddleware;

impl Middleware for AuthMiddleware {
    async fn execute(&self, mut ctx: Context<'_>) -> Response {
        let token = ctx.headers().get("authorization");

        match validate_token(token) {
            Ok(user) => {
                ctx.extensions.insert(user);
                ctx.next().await
            }
            Err(_) => Response::new()
                .status(StatusCode::UNAUTHORIZED)
                .text("Invalid token")
        }
    }
}
```

## Performance Notes

### Zero-Copy Design

The crate is designed around borrowed references:

```rust
// Params borrows from original path string
struct Params<'a> {
    inner: AHashMap<&'a str, &'a str>,
}

// Headers borrow from original request buffer
struct Headers<'a> {
    map: AHashMap<&'a str, &'a str>,
}

// ParsedRequest references original buffer
struct ParsedRequest<'a> {
    method: Method,
    path: &'a str,
    headers: Headers<'a>,
    body_offset: usize,  // Not a copy
}
```

### SIMD Optimizations

- `memchr` for scanning request lines
- `simdutf8` for UTF-8 validation
- `ahash` for fast hash maps

### Compilation

Include in release builds with:

```toml
[dependencies]
zap-core = { path = "../core" }
```

---

## See Also

- [zap-server](./zap-server.md) - HTTP server built on zap-core
- [Architecture](../ARCHITECTURE.md) - System design overview
- [Performance](../internals/performance.md) - Detailed benchmarks
