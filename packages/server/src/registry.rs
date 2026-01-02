//! Global registry for RPC-exported functions
//!
//! This module provides compile-time registration of functions marked with `#[zap::export]`.
//! It uses the `inventory` crate to collect functions across compilation units and builds
//! a runtime dispatcher that routes RPC calls to the appropriate handler functions.

use std::collections::HashMap;
use std::sync::Arc;
use serde_json::Value;
use futures::future::BoxFuture;

/// Wrapper around sync or async functions callable via RPC
///
/// This enum allows the registry to handle both synchronous and asynchronous
/// functions with a uniform interface.
pub enum FunctionWrapper {
    /// Synchronous function handler
    Sync(fn(&HashMap<String, Value>) -> Result<Value, String>),
    /// Asynchronous function handler (returns a boxed future)
    Async(fn(&HashMap<String, Value>) -> BoxFuture<'static, Result<Value, String>>),
}

impl FunctionWrapper {
    /// Call the wrapped function (async-safe for both sync and async functions)
    pub async fn call(&self, params: &HashMap<String, Value>) -> Result<Value, String> {
        match self {
            FunctionWrapper::Sync(f) => f(params),
            FunctionWrapper::Async(f) => f(params).await,
        }
    }
}

/// Metadata for an exported function
///
/// This struct is submitted to the inventory by the `#[zap::export]` macro
/// for each exported function in the codebase.
pub struct ExportedFunction {
    /// Function name (matches the original Rust function name)
    pub name: &'static str,
    /// Whether the function is async
    pub is_async: bool,
    /// The wrapper function that handles deserialization and execution
    pub wrapper: FunctionWrapper,
}

// Inventory collection point - collects all ExportedFunction instances at compile time
inventory::collect!(ExportedFunction);

// Lazy static runtime for fallback cases (testing, etc.)
lazy_static::lazy_static! {
    static ref FALLBACK_RUNTIME: tokio::runtime::Runtime = {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("zap-rpc-fallback")
            .enable_all()
            .build()
            .expect("Failed to create fallback Tokio runtime")
    };
}

/// Build RPC dispatcher from all registered functions
///
/// This function iterates through all functions registered via the `#[zap::export]` macro
/// and creates an RPC dispatcher that can route function calls by name.
///
/// # Returns
/// An `RpcDispatchFn` that can be used with the RPC server
///
/// # Important
/// The dispatcher uses `tokio::task::block_in_place` when called from within an async context
/// to avoid blocking the async executor. For test contexts without a runtime, it uses a
/// lazy-initialized fallback runtime.
///
/// # Example
/// ```no_run
/// let dispatcher = build_rpc_dispatcher();
/// // Use with RpcServerHandle::new()
/// ```
pub fn build_rpc_dispatcher() -> crate::rpc::RpcDispatchFn {
    use tracing::{info, debug};

    let mut registry: HashMap<String, &'static ExportedFunction> = HashMap::new();

    // Collect all registered functions from inventory
    for func in inventory::iter::<ExportedFunction> {
        debug!("Registered RPC function: {} (async: {})", func.name, func.is_async);
        registry.insert(func.name.to_string(), func);
    }

    info!("RPC registry: {} functions registered", registry.len());

    // Return dispatcher closure
    Arc::new(move |function_name: String, params: Value| {
        // Convert params to HashMap for wrapper functions
        let params_map: HashMap<String, Value> = match params {
            Value::Object(map) => map.into_iter().collect(),
            Value::Null => HashMap::new(), // Allow null params (no parameters)
            _ => {
                return Err(format!(
                    "RPC params must be an object, got: {}",
                    match params {
                        Value::Array(_) => "array",
                        Value::String(_) => "string",
                        Value::Number(_) => "number",
                        Value::Bool(_) => "boolean",
                        _ => "unknown"
                    }
                ))
            }
        };

        match registry.get(&function_name) {
            Some(func) => {
                // Check if we're in an async context
                match tokio::runtime::Handle::try_current() {
                    Ok(handle) => {
                        // We're in an async context - use block_in_place to avoid blocking the executor
                        // This moves the blocking work to a dedicated blocking thread
                        tokio::task::block_in_place(|| {
                            handle.block_on(func.wrapper.call(&params_map))
                        })
                    }
                    Err(_) => {
                        // No runtime available - use fallback runtime
                        // This handles test scenarios and standalone dispatcher usage
                        FALLBACK_RUNTIME.block_on(func.wrapper.call(&params_map))
                    }
                }
            }
            None => {
                Err(format!("RPC function '{}' not implemented", function_name))
            }
        }
    })
}
