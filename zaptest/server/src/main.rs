use zap_server::Zap;
use zap_server::export;
use zap_server::config::ZapConfig;
use zap_server::error::ZapResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::PathBuf;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use chrono::Utc;
use clap::Parser;
use tracing::{info, error};
use tracing_subscriber::EnvFilter;
use tokio::signal;

// ============================================================================
// DATA MODELS
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub excerpt: String,
    pub content: String,
    pub author: String,
    pub tags: Vec<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "readTime")]
    pub read_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostSummary {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub excerpt: String,
    pub author: String,
    pub tags: Vec<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "readTime")]
    pub read_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feature {
    pub id: String,
    pub icon: String,
    pub title: String,
    pub description: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Benchmark {
    pub name: String,
    #[serde(rename = "requestsPerSec")]
    pub requests_per_sec: u64,
    #[serde(rename = "latencyMs")]
    pub latency_ms: f64,
    #[serde(rename = "isHighlighted")]
    pub is_highlighted: bool,
}

// ============================================================================
// RESPONSE TYPES (for type-safe RPC)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListUsersResponse {
    pub users: Vec<User>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListPostsResponse {
    pub posts: Vec<PostSummary>,
    pub pagination: Pagination,
    pub filters: PostFilters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pagination {
    pub page: usize,
    pub limit: usize,
    pub total: usize,
    pub pages: usize,
    #[serde(rename = "hasNext")]
    pub has_next: bool,
    #[serde(rename = "hasPrev")]
    pub has_prev: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostFilters {
    pub tag: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsResponse {
    pub version: String,
    pub uptime: String,
    pub requests: u64,
    #[serde(rename = "responseTime")]
    pub response_time: String,
    pub environment: String,
    #[serde(rename = "serverStarted")]
    pub server_started: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeaturesResponse {
    pub features: Vec<Feature>,
    pub count: usize,
    #[serde(rename = "lastUpdated")]
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarksResponse {
    pub frameworks: Vec<Benchmark>,
    pub metrics: BenchmarkMetrics,
    pub machine: String,
    pub os: String,
    #[serde(rename = "lastUpdated")]
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkMetrics {
    #[serde(rename = "routeLookup")]
    pub route_lookup: String,
    pub throughput: String,
    pub memory: String,
    #[serde(rename = "p99Latency")]
    pub p99_latency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostWithRelated {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub excerpt: String,
    pub content: String,
    pub author: String,
    pub tags: Vec<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "readTime")]
    pub read_time: String,
    #[serde(rename = "relatedPosts")]
    pub related_posts: Vec<PostSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeResponse {
    pub success: bool,
    pub message: String,
    pub email: String,
    #[serde(rename = "subscribedAt")]
    pub subscribed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoResponse {
    pub method: String,
    pub url: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloResponse {
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteUserResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "deletedUser")]
    pub deleted_user: User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    pub code: String,
}

// ============================================================================
// ADVANCED FEATURE INFO TYPES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamingInfo {
    pub endpoint: String,
    #[serde(rename = "supportedFormats")]
    pub supported_formats: Vec<String>,
    #[serde(rename = "maxChunkSize")]
    pub max_chunk_size: usize,
    pub description: String,
    #[serde(rename = "exampleEvents")]
    pub example_events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSocketInfo {
    pub endpoint: String,
    pub protocol: String,
    pub commands: HashMap<String, String>,
    #[serde(rename = "connectedClients")]
    pub connected_clients: u32,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSGInfo {
    #[serde(rename = "staticRoutes")]
    pub static_routes: Vec<String>,
    #[serde(rename = "totalPages")]
    pub total_pages: usize,
    #[serde(rename = "buildTime")]
    pub build_time: String,
    pub description: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

// ============================================================================
// IN-MEMORY DATA STORES
// ============================================================================

static NEXT_USER_ID: AtomicU64 = AtomicU64::new(4);

static USERS: Lazy<RwLock<HashMap<String, User>>> = Lazy::new(|| {
    let mut users = HashMap::new();
    users.insert("1".to_string(), User {
        id: "1".to_string(),
        name: "Alice Johnson".to_string(),
        email: "alice@example.com".to_string(),
        role: "admin".to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
    });
    users.insert("2".to_string(), User {
        id: "2".to_string(),
        name: "Bob Smith".to_string(),
        email: "bob@example.com".to_string(),
        role: "user".to_string(),
        created_at: "2024-01-02T00:00:00Z".to_string(),
    });
    users.insert("3".to_string(), User {
        id: "3".to_string(),
        name: "Carol Williams".to_string(),
        email: "carol@example.com".to_string(),
        role: "user".to_string(),
        created_at: "2024-01-03T00:00:00Z".to_string(),
    });
    RwLock::new(users)
});

static POSTS: Lazy<Vec<Post>> = Lazy::new(|| {
    vec![
        Post {
            id: "1".to_string(),
            title: "Getting Started with ZapJS".to_string(),
            slug: "getting-started-with-zapjs".to_string(),
            excerpt: "Learn how to build your first fullstack application with ZapJS in under 5 minutes.".to_string(),
            content: r#"# Getting Started with ZapJS

ZapJS is a revolutionary fullstack framework that combines the performance of Rust with the developer experience of TypeScript.

## Prerequisites

- Node.js 18+ or Bun
- Rust toolchain (rustup)
- Basic knowledge of TypeScript and React

## Quick Start

```bash
npx create-zap-app my-app
cd my-app
bun install
bun run dev
```

That's it! You now have a fullstack ZapJS application running on http://localhost:3000."#.to_string(),
            author: "Alice Johnson".to_string(),
            tags: vec!["tutorial".to_string(), "beginner".to_string(), "rust".to_string()],
            published_at: "2024-01-15T10:00:00Z".to_string(),
            read_time: "5 min".to_string(),
        },
        Post {
            id: "2".to_string(),
            title: "Understanding File-Based Routing".to_string(),
            slug: "understanding-file-based-routing".to_string(),
            excerpt: "Deep dive into how ZapJS handles routing through your file system structure.".to_string(),
            content: r#"# Understanding File-Based Routing

File-based routing is one of the most intuitive ways to define your application routes.

## Route Conventions

| File | URL |
|------|-----|
| `routes/index.tsx` | `/` |
| `routes/about.tsx` | `/about` |
| `routes/blog/[id].tsx` | `/blog/:id` |"#.to_string(),
            author: "Bob Smith".to_string(),
            tags: vec!["routing".to_string(), "architecture".to_string(), "intermediate".to_string()],
            published_at: "2024-01-12T14:30:00Z".to_string(),
            read_time: "8 min".to_string(),
        },
        Post {
            id: "3".to_string(),
            title: "Type-Safe APIs with #[export]".to_string(),
            slug: "type-safe-apis-with-zap-export".to_string(),
            excerpt: "How to leverage Rust macros for automatic TypeScript type generation.".to_string(),
            content: r#"# Type-Safe APIs with #[export]

The `#[export]` macro is the heart of ZapJS type safety."#.to_string(),
            author: "Carol Williams".to_string(),
            tags: vec!["types".to_string(), "rust".to_string(), "advanced".to_string()],
            published_at: "2024-01-10T09:15:00Z".to_string(),
            read_time: "12 min".to_string(),
        },
        Post {
            id: "4".to_string(),
            title: "Deploying ZapJS to Production".to_string(),
            slug: "deploying-zapjs-to-production".to_string(),
            excerpt: "A complete guide to deploying your ZapJS application to various platforms.".to_string(),
            content: "One of the best features of ZapJS is the single binary deployment...".to_string(),
            author: "Alice Johnson".to_string(),
            tags: vec!["deployment".to_string(), "devops".to_string(), "production".to_string()],
            published_at: "2024-01-08T16:45:00Z".to_string(),
            read_time: "10 min".to_string(),
        },
        Post {
            id: "5".to_string(),
            title: "Building Real-Time Features".to_string(),
            slug: "building-real-time-features".to_string(),
            excerpt: "Implement WebSocket connections and live updates in your ZapJS app.".to_string(),
            content: "Real-time features are essential for modern web applications...".to_string(),
            author: "Bob Smith".to_string(),
            tags: vec!["websockets".to_string(), "real-time".to_string(), "advanced".to_string()],
            published_at: "2024-01-05T11:00:00Z".to_string(),
            read_time: "15 min".to_string(),
        },
        Post {
            id: "6".to_string(),
            title: "Performance Optimization Tips".to_string(),
            slug: "performance-optimization-tips".to_string(),
            excerpt: "Get the most out of ZapJS with these performance best practices.".to_string(),
            content: "While ZapJS is already fast out of the box, there are ways to make it even faster...".to_string(),
            author: "Carol Williams".to_string(),
            tags: vec!["performance".to_string(), "optimization".to_string(), "intermediate".to_string()],
            published_at: "2024-01-03T08:30:00Z".to_string(),
            read_time: "7 min".to_string(),
        },
    ]
});

static FEATURES: Lazy<Vec<Feature>> = Lazy::new(|| {
    vec![
        Feature {
            id: "performance".to_string(),
            icon: "Zap".to_string(),
            title: "Rust Performance".to_string(),
            description: "9ns route lookups, MessagePack RPC, connection pooling. Production-grade speed.".to_string(),
            color: "zap".to_string(),
        },
        Feature {
            id: "routing".to_string(),
            icon: "FileCode2".to_string(),
            title: "File-Based Routing".to_string(),
            description: "Next.js-style [param] routes, SSG with generateStaticParams, client-side router.".to_string(),
            color: "sky".to_string(),
        },
        Feature {
            id: "codegen".to_string(),
            icon: "Workflow".to_string(),
            title: "Full Type Safety".to_string(),
            description: "Bidirectional Rust-TypeScript types. Result<T, E> becomes T | Error unions.".to_string(),
            color: "emerald".to_string(),
        },
        Feature {
            id: "production".to_string(),
            icon: "Gauge".to_string(),
            title: "Production Ready".to_string(),
            description: "Security headers, rate limiting, CORS, Prometheus metrics, health probes.".to_string(),
            color: "violet".to_string(),
        },
        Feature {
            id: "resilience".to_string(),
            icon: "Shield".to_string(),
            title: "Built-in Resilience".to_string(),
            description: "Circuit breaker, IPC retry with backoff, graceful degradation.".to_string(),
            color: "rose".to_string(),
        },
        Feature {
            id: "realtime".to_string(),
            icon: "Layers".to_string(),
            title: "Real-time Support".to_string(),
            description: "WebSocket handlers, streaming responses, bidirectional communication.".to_string(),
            color: "amber".to_string(),
        },
        Feature {
            id: "dx".to_string(),
            icon: "RefreshCw".to_string(),
            title: "Developer Experience".to_string(),
            description: "Hot reload for Rust and TypeScript. ETag caching, structured logging.".to_string(),
            color: "cyan".to_string(),
        },
        Feature {
            id: "deploy".to_string(),
            icon: "Terminal".to_string(),
            title: "Simple Deployment".to_string(),
            description: "Single ~4MB binary. Docker ready. Cross-compilation supported.".to_string(),
            color: "pink".to_string(),
        },
    ]
});

static BENCHMARKS: Lazy<Vec<Benchmark>> = Lazy::new(|| {
    vec![
        Benchmark { name: "ZapJS".to_string(), requests_per_sec: 145000, latency_ms: 0.8, is_highlighted: true },
        Benchmark { name: "Actix".to_string(), requests_per_sec: 140000, latency_ms: 0.9, is_highlighted: false },
        Benchmark { name: "Hyper".to_string(), requests_per_sec: 135000, latency_ms: 1.0, is_highlighted: false },
        Benchmark { name: "Express".to_string(), requests_per_sec: 15000, latency_ms: 8.5, is_highlighted: false },
        Benchmark { name: "Next.js".to_string(), requests_per_sec: 12000, latency_ms: 10.2, is_highlighted: false },
    ]
});

// ============================================================================
// EXPORTED SERVER FUNCTIONS
// ============================================================================

/// List all users with pagination
#[export]
pub fn list_users(limit: u32, offset: u32) -> Result<ListUsersResponse, ApiError> {
    let users = USERS.read();
    let all_users: Vec<&User> = users.values().collect();
    let total = all_users.len();
    let limit = limit as usize;
    let offset = offset as usize;

    let paginated: Vec<_> = all_users
        .into_iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();

    Ok(ListUsersResponse {
        users: paginated,
        total,
        limit,
        offset,
        has_more: offset + limit < total,
    })
}

/// Get a single user by ID
#[export]
pub fn get_user(id: String) -> Result<User, ApiError> {
    let users = USERS.read();
    match users.get(&id) {
        Some(user) => Ok(user.clone()),
        None => Err(ApiError {
            error: "User not found".to_string(),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

/// Create a new user
#[export]
pub fn create_user(name: String, email: String, role: String) -> Result<User, ApiError> {
    // Validation
    if name.is_empty() || email.is_empty() {
        return Err(ApiError {
            error: "Name and email are required".to_string(),
            code: "VALIDATION_ERROR".to_string(),
        });
    }

    // Check for duplicate email
    {
        let users = USERS.read();
        if users.values().any(|u| u.email == email) {
            return Err(ApiError {
                error: "A user with this email already exists".to_string(),
                code: "DUPLICATE_EMAIL".to_string(),
            });
        }
    }

    let id = NEXT_USER_ID.fetch_add(1, Ordering::SeqCst).to_string();
    let new_user = User {
        id: id.clone(),
        name,
        email,
        role: if role == "admin" { "admin".to_string() } else { "user".to_string() },
        created_at: Utc::now().to_rfc3339(),
    };

    let mut users = USERS.write();
    users.insert(id, new_user.clone());

    Ok(new_user)
}

/// Update an existing user
#[export]
pub fn update_user(id: String, name: Option<String>, email: Option<String>, role: Option<String>) -> Result<User, ApiError> {
    let mut users = USERS.write();

    match users.get_mut(&id) {
        Some(user) => {
            if let Some(n) = name {
                user.name = n;
            }
            if let Some(e) = email {
                user.email = e;
            }
            if let Some(r) = role {
                user.role = if r == "admin" { "admin".to_string() } else { "user".to_string() };
            }
            Ok(user.clone())
        }
        None => Err(ApiError {
            error: "User not found".to_string(),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

/// Delete a user
#[export]
pub fn delete_user(id: String) -> Result<DeleteUserResponse, ApiError> {
    let mut users = USERS.write();

    match users.remove(&id) {
        Some(user) => Ok(DeleteUserResponse {
            success: true,
            message: format!("User {} deleted", id),
            deleted_user: user,
        }),
        None => Err(ApiError {
            error: "User not found".to_string(),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

/// List posts with pagination and filters
#[export]
pub fn list_posts(page: u32, limit: u32, tag: Option<String>, author: Option<String>) -> Result<ListPostsResponse, ApiError> {
    let page = page.max(1) as usize;
    let limit = limit.clamp(1, 50) as usize;

    let mut filtered: Vec<&Post> = POSTS.iter().collect();

    // Apply filters
    if let Some(ref t) = &tag {
        filtered.retain(|p| p.tags.contains(t));
    }
    if let Some(ref a) = &author {
        let a_lower = a.to_lowercase();
        filtered.retain(|p| p.author.to_lowercase().contains(&a_lower));
    }

    // Sort by date (newest first)
    filtered.sort_by(|a, b| b.published_at.cmp(&a.published_at));

    let total = filtered.len();
    let pages = total.div_ceil(limit);

    let paginated: Vec<PostSummary> = filtered
        .into_iter()
        .skip((page - 1) * limit)
        .take(limit)
        .map(|p| PostSummary {
            id: p.id.clone(),
            title: p.title.clone(),
            slug: p.slug.clone(),
            excerpt: p.excerpt.clone(),
            author: p.author.clone(),
            tags: p.tags.clone(),
            published_at: p.published_at.clone(),
            read_time: p.read_time.clone(),
        })
        .collect();

    Ok(ListPostsResponse {
        posts: paginated,
        pagination: Pagination {
            page,
            limit,
            total,
            pages,
            has_next: page < pages,
            has_prev: page > 1,
        },
        filters: PostFilters { tag, author },
    })
}

/// Get a single post by ID or slug
#[export]
pub fn get_post(id: String) -> Result<PostWithRelated, ApiError> {
    let post = POSTS.iter().find(|p| p.id == id || p.slug == id);

    match post {
        Some(p) => {
            // Find related posts (same tags)
            let related: Vec<PostSummary> = POSTS.iter()
                .filter(|other| other.id != p.id && other.tags.iter().any(|t| p.tags.contains(t)))
                .take(3)
                .map(|r| PostSummary {
                    id: r.id.clone(),
                    title: r.title.clone(),
                    slug: r.slug.clone(),
                    excerpt: r.excerpt.clone(),
                    author: r.author.clone(),
                    tags: r.tags.clone(),
                    published_at: r.published_at.clone(),
                    read_time: r.read_time.clone(),
                })
                .collect();

            Ok(PostWithRelated {
                id: p.id.clone(),
                title: p.title.clone(),
                slug: p.slug.clone(),
                excerpt: p.excerpt.clone(),
                content: p.content.clone(),
                author: p.author.clone(),
                tags: p.tags.clone(),
                published_at: p.published_at.clone(),
                read_time: p.read_time.clone(),
                related_posts: related,
            })
        }
        None => Err(ApiError {
            error: "Post not found".to_string(),
            code: "NOT_FOUND".to_string(),
        }),
    }
}

/// Get site statistics
#[export]
pub fn get_stats() -> Result<StatsResponse, ApiError> {
    Ok(StatsResponse {
        requests: 1847293,
        uptime: "99.99%".to_string(),
        version: "0.1.0".to_string(),
        response_time: "0.8ms".to_string(),
        server_started: "2024-01-01T00:00:00Z".to_string(),
        environment: "production".to_string(),
    })
}

/// Get features list
#[export]
pub fn get_features() -> Result<FeaturesResponse, ApiError> {
    Ok(FeaturesResponse {
        features: FEATURES.clone(),
        count: FEATURES.len(),
        last_updated: Utc::now().to_rfc3339(),
    })
}

/// Get benchmark data
#[export]
pub fn get_benchmarks() -> Result<BenchmarksResponse, ApiError> {
    Ok(BenchmarksResponse {
        frameworks: BENCHMARKS.clone(),
        metrics: BenchmarkMetrics {
            route_lookup: "9ns".to_string(),
            throughput: "145k/s".to_string(),
            memory: "12MB".to_string(),
            p99_latency: "<2ms".to_string(),
        },
        machine: "Apple M2 Max, 32GB RAM".to_string(),
        os: "macOS 14.0".to_string(),
        last_updated: "2024-01-15T00:00:00Z".to_string(),
    })
}

/// Subscribe to newsletter
#[export]
pub fn subscribe(email: String) -> Result<SubscribeResponse, ApiError> {
    // Validate email presence
    if email.is_empty() {
        return Err(ApiError {
            error: "Email is required".to_string(),
            code: "MISSING_EMAIL".to_string(),
        });
    }

    // Validate email format
    let email_regex = regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
    if !email_regex.is_match(&email) {
        return Err(ApiError {
            error: "Invalid email format".to_string(),
            code: "INVALID_EMAIL".to_string(),
        });
    }

    // Simulate checking for existing subscription
    if email == "already@subscribed.com" {
        return Err(ApiError {
            error: "This email is already subscribed".to_string(),
            code: "ALREADY_SUBSCRIBED".to_string(),
        });
    }

    println!("[Newsletter] New subscription: {}", email);

    Ok(SubscribeResponse {
        success: true,
        message: "Successfully subscribed to the newsletter!".to_string(),
        email,
        subscribed_at: Utc::now().to_rfc3339(),
    })
}

/// Echo request details (for debugging)
#[export]
pub fn echo_request(
    method: String,
    url: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Option<String>
) -> Result<EchoResponse, ApiError> {
    Ok(EchoResponse {
        method,
        url,
        query,
        headers,
        body,
        timestamp: Utc::now().to_rfc3339(),
    })
}

/// Hello endpoint
#[export]
pub fn hello() -> Result<HelloResponse, ApiError> {
    Ok(HelloResponse {
        message: "Hello from ZapJS!".to_string(),
        timestamp: Utc::now().to_rfc3339(),
    })
}

/// Get streaming endpoint info
#[export]
pub fn get_streaming_info() -> Result<StreamingInfo, ApiError> {
    Ok(StreamingInfo {
        endpoint: "/api/stream".to_string(),
        supported_formats: vec![
            "text/event-stream".to_string(),
            "application/json".to_string(),
        ],
        max_chunk_size: 65536,
        description: "Server-Sent Events streaming with async generators. Stream data in real-time with backpressure support.".to_string(),
        example_events: vec![
            "event: start".to_string(),
            "event: progress".to_string(),
            "event: complete".to_string(),
        ],
    })
}

/// Get WebSocket endpoint info
#[export]
pub fn get_websocket_info() -> Result<WebSocketInfo, ApiError> {
    let mut commands = HashMap::new();
    commands.insert("ping".to_string(), "Send { type: 'ping' } to receive pong response".to_string());
    commands.insert("broadcast".to_string(), "Send { type: 'broadcast', content: '...' } to broadcast to all clients".to_string());
    commands.insert("stats".to_string(), "Send { type: 'stats' } to get connection statistics".to_string());
    commands.insert("echo".to_string(), "Any other message will be echoed back with timestamp".to_string());

    Ok(WebSocketInfo {
        endpoint: "/api/ws-echo".to_string(),
        protocol: "websocket".to_string(),
        commands,
        connected_clients: 0, // Would be dynamic in real impl with shared state
        description: "WebSocket echo server with broadcast support. Full bidirectional real-time communication.".to_string(),
    })
}

/// Get SSG (Static Site Generation) info
#[export]
pub fn get_ssg_info() -> Result<SSGInfo, ApiError> {
    // Get actual blog post slugs for SSG demonstration
    let routes: Vec<String> = POSTS.iter()
        .map(|p| format!("/blog/{}", p.slug))
        .collect();
    let total = routes.len();

    Ok(SSGInfo {
        static_routes: routes,
        total_pages: total,
        build_time: "1.2s".to_string(),
        description: "Pre-rendered blog pages using generateStaticParams(). Each route is built at compile time for instant loading.".to_string(),
        generated_at: Utc::now().to_rfc3339(),
    })
}

// ============================================================================
// RPC DISPATCHER
// ============================================================================

/// RPC request structure
#[derive(Debug, Deserialize)]
struct RpcRequest {
    method: String,
    params: HashMap<String, Value>,
}

/// RPC response structure
#[derive(Debug, Serialize)]
struct RpcResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ApiError>,
}

/// Helper macro to handle Result<T, ApiError> -> RpcResponse conversion
macro_rules! dispatch_result {
    ($result:expr) => {
        match $result {
            Ok(data) => RpcResponse {
                success: true,
                data: Some(serde_json::to_value(data).unwrap()),
                error: None,
            },
            Err(e) => RpcResponse {
                success: false,
                data: None,
                error: Some(e),
            },
        }
    };
}

/// Dispatch RPC calls to the appropriate exported functions
fn dispatch_rpc(request: RpcRequest) -> RpcResponse {
    match request.method.as_str() {
        // User functions
        "list_users" => {
            let limit = request.params.get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(10) as u32;
            let offset = request.params.get("offset")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            dispatch_result!(list_users(limit, offset))
        }
        "get_user" => {
            let id = request.params.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            dispatch_result!(get_user(id))
        }
        "create_user" => {
            let name = request.params.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let email = request.params.get("email")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let role = request.params.get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("user")
                .to_string();
            dispatch_result!(create_user(name, email, role))
        }
        "update_user" => {
            let id = request.params.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = request.params.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let email = request.params.get("email")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let role = request.params.get("role")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            dispatch_result!(update_user(id, name, email, role))
        }
        "delete_user" => {
            let id = request.params.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            dispatch_result!(delete_user(id))
        }

        // Post functions
        "list_posts" => {
            let page = request.params.get("page")
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as u32;
            let limit = request.params.get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(10) as u32;
            let tag = request.params.get("tag")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let author = request.params.get("author")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            dispatch_result!(list_posts(page, limit, tag, author))
        }
        "get_post" => {
            let id = request.params.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            dispatch_result!(get_post(id))
        }

        // Other functions
        "get_stats" => dispatch_result!(get_stats()),
        "get_features" => dispatch_result!(get_features()),
        "get_benchmarks" => dispatch_result!(get_benchmarks()),
        "hello" => dispatch_result!(hello()),

        // Advanced feature info endpoints
        "get_streaming_info" => dispatch_result!(get_streaming_info()),
        "get_websocket_info" => dispatch_result!(get_websocket_info()),
        "get_ssg_info" => dispatch_result!(get_ssg_info()),

        "subscribe" => {
            let email = request.params.get("email")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            dispatch_result!(subscribe(email))
        }

        "echo_request" => {
            let method = request.params.get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_string();
            let url = request.params.get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("/")
                .to_string();
            let query: HashMap<String, String> = request.params.get("query")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let headers: HashMap<String, String> = request.params.get("headers")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let body = request.params.get("body")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            dispatch_result!(echo_request(method, url, query, headers, body))
        }

        _ => RpcResponse {
            success: false,
            data: None,
            error: Some(ApiError {
                error: format!("Unknown RPC method: {}", request.method),
                code: "UNKNOWN_METHOD".to_string(),
            }),
        },
    }
}

// ============================================================================
// CLI ARGUMENTS
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "Zap")]
#[command(version = "1.0.0")]
#[command(about = "ZapJS HTTP server with Rust backend functions", long_about = None)]
struct Args {
    /// Path to JSON configuration file (dev mode)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Override HTTP server port
    #[arg(short, long)]
    port: Option<u16>,

    /// Override HTTP server hostname
    #[arg(long)]
    hostname: Option<String>,

    /// Unix socket path for IPC with TypeScript wrapper
    #[arg(short, long)]
    socket: Option<String>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    log_level: String,
}

// ============================================================================
// LOGGING AND SIGNALS
// ============================================================================

fn init_logging(level: &str) -> ZapResult<()> {
    let env_filter = level.parse::<EnvFilter>().map_err(|e| {
        zap_server::error::ZapError::config(format!(
            "Invalid log level '{}': {}",
            level, e
        ))
    })?;

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_file(true)
        .with_line_number(true)
        .with_ansi(true)
        .init();

    Ok(())
}

async fn setup_signal_handlers() {
    #[cfg(unix)]
    {
        let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to setup SIGTERM handler");
        let mut sigint = signal::unix::signal(signal::unix::SignalKind::interrupt())
            .expect("Failed to setup SIGINT handler");

        tokio::select! {
            _ = sigterm.recv() => {
                info!("Received SIGTERM signal");
            }
            _ = sigint.recv() => {
                info!("Received SIGINT signal");
            }
            _ = signal::ctrl_c() => {
                info!("Received Ctrl+C");
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = signal::ctrl_c().await;
        info!("Received Ctrl+C");
    }
}

// ============================================================================
// MAIN
// ============================================================================

#[tokio::main]
async fn main() -> ZapResult<()> {
    let args = Args::parse();

    // Initialize logging
    init_logging(&args.log_level)?;

    // Check if we're in dev mode (config provided) or standalone mode
    if let Some(config_path) = args.config {
        // DEV MODE: Load config for IPC proxying to TypeScript routes,
        // but RPC endpoint calls Rust functions directly (no IPC round-trip)
        info!("🚀 Starting Zap HTTP server v1.0.0 (dev mode)");

        let mut config = ZapConfig::from_file(config_path.to_str().unwrap())?;

        info!("📋 Configuration loaded from {}", config_path.display());

        // Apply CLI argument overrides
        if let Some(port) = args.port {
            info!("⚙️  Overriding port: {}", port);
            config.port = port;
        }
        if let Some(hostname) = args.hostname {
            info!("⚙️  Overriding hostname: {}", hostname);
            config.hostname = hostname.clone();
        }
        if let Some(socket) = args.socket {
            info!("⚙️  Overriding IPC socket: {}", socket);
            config.ipc_socket_path = socket;
        }

        // Validate configuration
        config.validate().await?;

        let server_hostname = config.hostname.clone();
        let server_port = config.port;
        let ipc_socket_path = config.ipc_socket_path.clone();

        info!("📡 Server will listen on http://{}:{}", server_hostname, server_port);
        info!("🔌 IPC socket: {}", ipc_socket_path);
        info!("📊 Routes: {}", config.routes.len());

        // Create RPC dispatch adapter for IPC communication
        use std::sync::Arc;
        use serde_json::Value;

        let rpc_dispatch_fn = Arc::new(|function_name: String, params: Value| -> Result<Value, String> {
            // Convert params from Value to HashMap
            let params_map = if let Value::Object(map) = params {
                map.into_iter().collect()
            } else {
                HashMap::new()
            };

            let request = RpcRequest {
                method: function_name,
                params: params_map,
            };

            let response = dispatch_rpc(request);

            if response.success {
                Ok(response.data.unwrap_or(Value::Null))
            } else {
                Err(response.error
                    .map(|e| e.error)
                    .unwrap_or_else(|| "Unknown error".to_string()))
            }
        });

        // Attach RPC dispatch to config
        config.rpc_dispatch = Some(rpc_dispatch_fn);

        // Create server from config (IPC proxying for TypeScript routes + RPC server)
        let app = Zap::from_config(config).await?;

        println!("🚀 ZapJS server running on http://{}:{}", server_hostname, server_port);
        println!("🔧 RPC server running on {}.rpc (IPC)", ipc_socket_path);

        info!("✅ Zap server initialized successfully (dev mode)");

        tokio::select! {
            result = app.listen() => {
                if let Err(e) = result {
                    error!("Server error: {}", e);
                    return Err(e);
                }
            }
            _ = setup_signal_handlers() => {
                info!("📛 Received shutdown signal");
            }
        }
    } else {
        // STANDALONE MODE: Run with hardcoded routes
        info!("🚀 Starting Zap HTTP server v1.0.0 (standalone mode)");

        let port = args.port.unwrap_or(3000);
        let hostname = args.hostname.unwrap_or_else(|| "127.0.0.1".to_string());

        let app = Zap::new()
            .port(port)
            .hostname(&hostname)
            .cors()
            .logging()
            .json_get("/api/health", |_req| {
                json!({ "status": "ok" })
            });

        println!("🚀 ZapJS server running on http://{}:{}", hostname, port);

        info!("✅ Zap server initialized successfully (standalone mode)");

        tokio::select! {
            result = app.listen() => {
                if let Err(e) = result {
                    error!("Server error: {}", e);
                    return Err(e);
                }
            }
            _ = setup_signal_handlers() => {
                info!("📛 Received shutdown signal");
            }
        }
    }

    info!("👋 Zap server shut down successfully");
    Ok(())
}
