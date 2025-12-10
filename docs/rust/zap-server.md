# zap-server

The `zap-server` crate provides the complete HTTP server implementation for Zap.js, built on top of `zap-core`. It includes handler abstractions, IPC communication with TypeScript, static file serving, and server configuration.

## Overview

```
zap-server/
├── lib.rs          # Public exports
├── server.rs       # Zap struct - main server API
├── handler.rs      # Handler traits and types
├── ipc.rs          # IPC protocol implementation
├── proxy.rs        # TypeScript handler proxy
├── request.rs      # RequestData - owned request
├── response.rs     # ZapResponse enum
├── config.rs       # ZapConfig - server configuration
├── static.rs       # Static file serving
├── error.rs        # ZapError types
└── bin/zap.rs      # Binary entry point
```

## Zap Server

The main `Zap` struct provides a fluent API for building HTTP servers.

### Basic Usage

```rust
use zap_server::Zap;

#[tokio::main]
async fn main() {
    Zap::new()
        .port(3000)
        .hostname("127.0.0.1".to_string())
        .get("/", |_| async { "Hello, World!".into() })
        .get("/users/:id", get_user)
        .post("/users", create_user)
        .static_files("/assets", "./public")
        .logging()
        .cors()
        .listen()
        .await
        .unwrap();
}

async fn get_user(req: RequestData) -> ZapResponse {
    let id = req.param("id").unwrap_or("0");
    ZapResponse::Json(serde_json::json!({
        "id": id,
        "name": "John"
    }))
}

async fn create_user(req: RequestData) -> ZapResponse {
    let body: User = serde_json::from_str(&req.body_string()).unwrap();
    ZapResponse::Json(serde_json::json!({ "created": body }))
}
```

### Route Registration

```rust
impl Zap {
    // Sync handlers
    pub fn get(self, path: &str, handler: impl Handler) -> Self;
    pub fn post(self, path: &str, handler: impl Handler) -> Self;
    pub fn put(self, path: &str, handler: impl Handler) -> Self;
    pub fn delete(self, path: &str, handler: impl Handler) -> Self;
    pub fn patch(self, path: &str, handler: impl Handler) -> Self;
    pub fn head(self, path: &str, handler: impl Handler) -> Self;
    pub fn options(self, path: &str, handler: impl Handler) -> Self;

    // Async handlers
    pub fn get_async<F, Fut>(self, path: &str, handler: F) -> Self
    where
        F: Fn(RequestData) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ZapResponse> + Send;

    // Simple handlers (return String)
    pub fn get_simple(self, path: &str, handler: fn() -> String) -> Self;

    // JSON convenience methods
    pub fn json_get<F, T>(self, path: &str, handler: F) -> Self
    where
        F: Fn(RequestData) -> T + Send + Sync + 'static,
        T: Serialize;
}
```

### Configuration

```rust
impl Zap {
    /// Set server port
    pub fn port(self, port: u16) -> Self;

    /// Set hostname
    pub fn hostname(self, hostname: String) -> Self;

    /// Set keep-alive timeout
    pub fn keep_alive_timeout(self, duration: Duration) -> Self;

    /// Set maximum request body size
    pub fn max_request_body_size(self, size: usize) -> Self;

    /// Set request timeout
    pub fn request_timeout(self, duration: Duration) -> Self;
}
```

### Middleware

```rust
impl Zap {
    /// Add custom middleware
    pub fn use_middleware<M: Middleware>(self, middleware: M) -> Self;

    /// Enable request logging
    pub fn logging(self) -> Self;

    /// Enable CORS (permissive)
    pub fn cors(self) -> Self;
}
```

### Static Files

```rust
impl Zap {
    /// Serve static files from directory
    pub fn static_files(self, prefix: &str, directory: &str) -> Self;

    /// With custom options
    pub fn static_files_with_options(
        self,
        prefix: &str,
        directory: &str,
        options: StaticOptions
    ) -> Self;
}

pub struct StaticOptions {
    pub directory_listing: bool,
    pub cache_control: Option<String>,
    pub headers: HashMap<String, String>,
    pub compress: bool,
}
```

### Health & Metrics

```rust
impl Zap {
    /// Add health check endpoint
    pub fn health_check(self, path: &str) -> Self;

    /// Add metrics endpoint
    pub fn metrics(self, path: &str) -> Self;
}
```

### Lifecycle

```rust
impl Zap {
    /// Start the server (blocks until shutdown)
    pub async fn listen(self) -> Result<(), ZapError>;

    /// Create from configuration file
    pub async fn from_config(config: ZapConfig) -> Result<Self, ZapError>;
}
```

## Handler Trait

Handlers process requests and return responses.

```rust
pub trait Handler: Send + Sync {
    fn handle<'a>(
        &'a self,
        req: RequestData,
    ) -> Pin<Box<dyn Future<Output = Result<ZapResponse, ZapError>> + Send + 'a>>;
}
```

### Handler Types

```rust
// Simple closure returning String
let handler = |_req| "Hello".to_string();

// Closure returning ZapResponse
let handler = |req: RequestData| {
    ZapResponse::Json(serde_json::json!({"id": req.param("id")}))
};

// Async closure
let handler = |req: RequestData| async move {
    let data = fetch_data(req.param("id")).await;
    ZapResponse::Json(data)
};

// Function
async fn handler(req: RequestData) -> ZapResponse {
    ZapResponse::Text("Hello".to_string())
}
```

## RequestData

Owned request data passed to handlers.

```rust
pub struct RequestData {
    pub method: Method,
    pub path: String,
    pub path_only: String,       // Without query string
    pub version: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub params: HashMap<String, String>,   // Route parameters
    pub query: HashMap<String, String>,    // Query string
    pub cookies: HashMap<String, String>,
}
```

### API

```rust
impl RequestData {
    /// Get route parameter
    pub fn param(&self, name: &str) -> Option<&str>;

    /// Get query parameter
    pub fn query(&self, name: &str) -> Option<&str>;

    /// Get header value
    pub fn header(&self, name: &str) -> Option<&str>;

    /// Get cookie value
    pub fn cookie(&self, name: &str) -> Option<&str>;

    /// Get body as string
    pub fn body_string(&self) -> String;

    /// Convert from borrowed Request
    pub fn from_request(req: &Request<'_>) -> Self;
}
```

## ZapResponse

Response variants for different content types.

```rust
pub enum ZapResponse {
    /// Plain text response
    Text(String),

    /// HTML response
    Html(String),

    /// JSON response (auto-serialized)
    Json(serde_json::Value),

    /// Raw bytes
    Bytes(Bytes),

    /// File from path
    File(PathBuf),

    /// Custom response with full control
    Custom(Response),

    /// Redirect to URL
    Redirect(String),

    /// Status code only
    Status(StatusCode),
}
```

### Usage

```rust
// Text
ZapResponse::Text("Hello".to_string())

// JSON (from serde_json::Value)
ZapResponse::Json(serde_json::json!({
    "id": 1,
    "name": "John"
}))

// JSON (from serializable type)
let user = User { id: 1, name: "John".to_string() };
ZapResponse::Json(serde_json::to_value(&user).unwrap())

// Redirect
ZapResponse::Redirect("/login".to_string())

// Custom response
ZapResponse::Custom(
    Response::new()
        .status(StatusCode::CREATED)
        .header("X-Custom", "value")
        .body(data)
)
```

### Json Helper

```rust
pub struct Json<T>(pub T);

impl<T: Serialize> From<Json<T>> for ZapResponse {
    fn from(json: Json<T>) -> Self {
        ZapResponse::Json(serde_json::to_value(json.0).unwrap())
    }
}

// Usage
fn handler(req: RequestData) -> ZapResponse {
    Json(User { id: 1, name: "John".to_string() }).into()
}
```

## IPC Protocol

Communication between Rust server and TypeScript handlers.

### Message Types

```rust
pub enum IpcMessage {
    /// Request TypeScript handler execution
    InvokeHandler {
        handler_id: String,
        request: IpcRequest,
    },

    /// Response from TypeScript handler
    HandlerResponse {
        handler_id: String,
        status: u16,
        headers: HashMap<String, String>,
        body: String,
    },

    /// Health check ping
    HealthCheck,

    /// Health check response
    HealthCheckResponse,

    /// Error response
    Error {
        code: String,
        message: String,
    },
}
```

### IpcRequest

```rust
pub struct IpcRequest {
    pub method: String,
    pub path: String,
    pub path_only: String,
    pub query: HashMap<String, String>,
    pub params: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub cookies: HashMap<String, String>,
}
```

### IpcServer (TypeScript side calls)

```rust
pub struct IpcServer {
    socket_path: String,
}

impl IpcServer {
    /// Create server at socket path
    pub fn new(socket_path: &str) -> Self;

    /// Start listening (spawns background task)
    pub async fn listen(&self) -> Result<(), ZapError>;
}
```

### IpcClient (Rust side calls)

```rust
pub struct IpcClient {
    stream: UnixStream,
}

impl IpcClient {
    /// Connect to IPC server
    pub async fn connect(socket_path: &str) -> Result<Self, ZapError>;

    /// Send message
    pub async fn send_message(&mut self, msg: &IpcMessage) -> Result<(), ZapError>;

    /// Receive message
    pub async fn recv_message(&mut self) -> Result<IpcMessage, ZapError>;
}
```

## Configuration

### ZapConfig

```rust
pub struct ZapConfig {
    /// Server port
    pub port: u16,

    /// Server hostname
    pub hostname: String,

    /// Unix socket path for IPC
    pub ipc_socket_path: String,

    /// Maximum request body size (bytes)
    pub max_request_body_size: usize,

    /// Request timeout (seconds)
    pub request_timeout_secs: u64,

    /// Keep-alive timeout (seconds)
    pub keepalive_timeout_secs: u64,

    /// Route configurations
    pub routes: Vec<RouteConfig>,

    /// Static file configurations
    pub static_files: Vec<StaticFileConfig>,

    /// Middleware settings
    pub middleware: MiddlewareConfig,

    /// Health check endpoint path
    pub health_check_path: String,

    /// Metrics endpoint path (optional)
    pub metrics_path: Option<String>,
}
```

### RouteConfig

```rust
pub struct RouteConfig {
    /// HTTP method
    pub method: String,

    /// URL path pattern
    pub path: String,

    /// Handler identifier
    pub handler_id: String,

    /// Whether handler is in TypeScript
    pub is_typescript: bool,
}
```

### Loading Configuration

```rust
impl ZapConfig {
    /// Create with defaults
    pub fn new() -> Self;

    /// Load from JSON file
    pub fn from_file(path: &str) -> Result<Self, ZapError>;

    /// Validate configuration
    pub fn validate(&self) -> Result<(), ZapError>;

    /// Get socket address string
    pub fn socket_addr(&self) -> String;

    /// Get request timeout as Duration
    pub fn request_timeout(&self) -> Duration;

    /// Get keep-alive timeout as Duration
    pub fn keepalive_timeout(&self) -> Duration;
}
```

## Error Handling

```rust
pub enum ZapError {
    /// HTTP-level errors
    Http(String),

    /// Routing errors
    Routing(String),

    /// Handler execution errors
    Handler(String),

    /// IPC communication errors
    Ipc(String),

    /// Configuration errors
    Config(String),

    /// I/O errors
    Io(io::Error),

    /// Serialization errors
    Serialization(serde_json::Error),

    /// Invalid state errors
    InvalidState(String),

    /// Timeout errors
    Timeout(String),

    /// Internal errors
    Internal(String),
}

pub type ZapResult<T> = Result<T, ZapError>;
```

## Binary Entry Point

The `zap` binary (`src/bin/zap.rs`) is the production server.

### CLI Arguments

```bash
zap [OPTIONS]

Options:
    --config <PATH>     Path to config.json
    --port <PORT>       Override port from config
    --host <HOST>       Override hostname from config
    --log-level <LEVEL> Log level (debug, info, warn, error)
```

### Startup Flow

```rust
#[tokio::main]
async fn main() -> Result<(), ZapError> {
    // 1. Parse CLI arguments
    let args = Args::parse();

    // 2. Load config
    let mut config = ZapConfig::from_file(&args.config)?;

    // 3. Apply CLI overrides
    if let Some(port) = args.port {
        config.port = port;
    }

    // 4. Validate
    config.validate()?;

    // 5. Create server
    let app = Zap::from_config(config).await?;

    // 6. Run with signal handling
    tokio::select! {
        result = app.listen() => result,
        _ = signal::ctrl_c() => {
            println!("Shutting down...");
            Ok(())
        }
    }
}
```

## Static File Serving

```rust
pub struct StaticHandler {
    pub prefix: String,      // URL prefix, e.g., "/assets"
    pub directory: String,   // Filesystem path
    pub options: StaticOptions,
}

/// Serve static file request
pub async fn handle_static_files(
    prefix: &str,
    directory: &str,
    path: &str,
    options: &StaticOptions,
) -> Result<ZapResponse, ZapError>;
```

### MIME Type Detection

Automatic MIME type detection based on file extension:

| Extension | MIME Type |
|-----------|-----------|
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.json` | `application/json` |
| `.png` | `image/png` |
| `.jpg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.woff2` | `font/woff2` |

---

## Example: Complete Server

```rust
use zap_server::{Zap, ZapResponse, RequestData, Json};
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct User {
    id: u64,
    name: String,
    email: String,
}

#[tokio::main]
async fn main() {
    Zap::new()
        .port(3000)
        .hostname("0.0.0.0".to_string())

        // Routes
        .get("/", |_| async { ZapResponse::Text("Welcome to Zap!".into()) })
        .get("/users", list_users)
        .get("/users/:id", get_user)
        .post("/users", create_user)
        .delete("/users/:id", delete_user)

        // Static files
        .static_files("/assets", "./public/assets")

        // Middleware
        .logging()
        .cors()

        // Health check
        .health_check("/health")

        .listen()
        .await
        .unwrap();
}

async fn list_users(_req: RequestData) -> ZapResponse {
    let users = vec![
        User { id: 1, name: "Alice".into(), email: "alice@example.com".into() },
        User { id: 2, name: "Bob".into(), email: "bob@example.com".into() },
    ];
    Json(users).into()
}

async fn get_user(req: RequestData) -> ZapResponse {
    let id: u64 = req.param("id").unwrap().parse().unwrap_or(0);
    Json(User {
        id,
        name: format!("User {}", id),
        email: format!("user{}@example.com", id),
    }).into()
}

async fn create_user(req: RequestData) -> ZapResponse {
    let user: User = serde_json::from_str(&req.body_string()).unwrap();
    ZapResponse::Custom(
        Response::new()
            .status(StatusCode::CREATED)
            .header("Location", format!("/users/{}", user.id))
            .body(serde_json::to_string(&user).unwrap())
    )
}

async fn delete_user(req: RequestData) -> ZapResponse {
    let id = req.param("id").unwrap();
    Json(serde_json::json!({ "deleted": id })).into()
}
```

---

## See Also

- [zap-core](./zap-core.md) - HTTP primitives
- [zap-macros](./zap-macros.md) - Export macro
- [IPC Protocol](../internals/ipc-protocol.md) - IPC details
- [Architecture](../ARCHITECTURE.md) - System design
