use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use zap_server::{export, Context};

// Test 1: Simple sync function (no Context)
#[export]
pub fn hello_world() -> String {
    "Hello from Rust!".to_string()
}

// Test 2: Sync function with parameters
#[export]
pub fn add_numbers(a: i32, b: i32) -> i32 {
    a + b
}

// Test 3: Async function with Context
#[export]
pub async fn get_trace_info(ctx: &Context) -> serde_json::Value {
    serde_json::json!({
        "trace_id": ctx.trace_id(),
        "span_id": ctx.span_id(),
    })
}

// Test 4: Function that reads headers
#[export]
pub fn echo_headers(ctx: &Context) -> serde_json::Value {
    let headers: Vec<(String, String)> = ctx
        .headers()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    serde_json::json!({ "headers": headers })
}

// Test 5: Function that checks auth context
#[export]
pub fn check_auth(ctx: &Context) -> Result<serde_json::Value, String> {
    let user_id = ctx.user_id().ok_or("Not authenticated")?;

    let is_admin = ctx.has_role("admin");

    Ok(serde_json::json!({
        "user_id": user_id,
        "is_admin": is_admin,
        "roles": ctx.auth().map(|a| &a.roles),
    }))
}

// Test 6: Function that deliberately panics (crash recovery test)
#[export]
pub fn panic_function(should_panic: bool) -> String {
    if should_panic {
        panic!("Deliberate panic for testing!");
    }
    "Success".to_string()
}

// Test 7: Function with complex types
#[derive(Serialize, Deserialize)]
pub struct User {
    pub name: String,
    pub age: u32,
    pub email: String,
}

#[export]
pub fn process_user(user: User) -> Result<String, String> {
    if user.age < 18 {
        return Err("User must be 18 or older".to_string());
    }
    Ok(format!("Processed user: {}", user.name))
}

// Test 8: Async function with delay (for testing timeouts)
#[export]
pub async fn slow_function(delay_ms: u64) -> String {
    tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
    "Completed".to_string()
}

// Test 9: Counter for hot reload testing
static VERSION_COUNTER: AtomicU32 = AtomicU32::new(1);

#[export]
pub fn get_version() -> u32 {
    VERSION_COUNTER.load(Ordering::SeqCst)
}
