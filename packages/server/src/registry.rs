//! Global registry for RPC-exported functions
//!
//! This module provides compile-time registration of functions marked with `#[zap::export]`.
//! It uses the `linkme` crate to collect functions across compilation units and builds
//! a runtime dispatcher that routes RPC calls to the appropriate handler functions.

use std::collections::HashMap;
use std::sync::Arc;
use serde_json::Value;
use futures::future::BoxFuture;
use crate::context::Context;

/// Wrapper around sync or async functions callable via RPC
///
/// This enum allows the registry to handle both synchronous and asynchronous
/// functions with a uniform interface. Supports both legacy (no Context) and
/// context-aware functions.
pub enum FunctionWrapper {
    /// Synchronous function handler (legacy - no Context)
    Sync(fn(&HashMap<String, Value>) -> Result<Value, String>),
    /// Asynchronous function handler (legacy - no Context)
    Async(fn(&HashMap<String, Value>) -> BoxFuture<'static, Result<Value, String>>),
    /// Synchronous function handler with Context support
    SyncCtx(fn(&Context, &HashMap<String, Value>) -> Result<Value, String>),
    /// Asynchronous function handler with Context support
    AsyncCtx(fn(&Context, &HashMap<String, Value>) -> BoxFuture<'static, Result<Value, String>>),
}

impl FunctionWrapper {
    /// Call the wrapped function (async-safe for both sync and async functions)
    ///
    /// # Arguments
    /// * `context` - Optional request context (required for SyncCtx/AsyncCtx variants)
    /// * `params` - Function parameters as JSON HashMap
    pub async fn call(
        &self,
        context: Option<&Context>,
        params: &HashMap<String, Value>
    ) -> Result<Value, String> {
        match self {
            FunctionWrapper::Sync(f) => f(params),
            FunctionWrapper::Async(f) => f(params).await,
            FunctionWrapper::SyncCtx(f) => {
                let ctx = context.ok_or_else(||
                    "Function requires context but none provided. \
                     Ensure the function is called through the Splice protocol.".to_string()
                )?;
                f(ctx, params)
            }
            FunctionWrapper::AsyncCtx(f) => {
                let ctx = context.ok_or_else(||
                    "Function requires context but none provided. \
                     Ensure the function is called through the Splice protocol.".to_string()
                )?;
                f(ctx, params).await
            }
        }
    }
}

/// Metadata for an exported function
///
/// This struct is registered via the `#[zap::export]` macro for each exported
/// function in the codebase using linkme's distributed slice mechanism.
pub struct ExportedFunction {
    /// Function name (matches the original Rust function name)
    pub name: &'static str,
    /// Whether the function is async
    pub is_async: bool,
    /// Whether the function requires Context parameter
    pub has_context: bool,
    /// The wrapper function that handles deserialization and execution
    pub wrapper: FunctionWrapper,
}

// linkme distributed slice - collects all ExportedFunction instances at link time
// linkme automatically creates a slice of &'static references
#[linkme::distributed_slice]
pub static EXPORTS: [ExportedFunction];

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
/// use zap_server::build_rpc_dispatcher;
///
/// let dispatcher = build_rpc_dispatcher();
/// // Use with RpcServerHandle::new()
/// ```
pub fn build_rpc_dispatcher() -> crate::rpc::RpcDispatchFn {
    use tracing::{info, debug};

    let mut registry: HashMap<String, &'static ExportedFunction> = HashMap::new();

    // Collect all registered functions from linkme distributed slice
    for func in EXPORTS {
        debug!(
            "Registered RPC function: {} (async: {}, context: {})",
            func.name, func.is_async, func.has_context
        );
        registry.insert(func.name.to_string(), func);
    }

    info!("RPC registry: {} functions registered", registry.len());

    // Return dispatcher closure with context support
    Arc::new(move |function_name: String, params: Value, context_data: Option<splice::protocol::RequestContext>| {
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
                // Convert RequestContext to Context wrapper if provided
                let context = context_data.map(|c| Context::new(c));

                // Check if we're in an async context
                match tokio::runtime::Handle::try_current() {
                    Ok(handle) => {
                        // We're in an async context - use block_in_place to avoid blocking the executor
                        // This moves the blocking work to a dedicated blocking thread
                        tokio::task::block_in_place(|| {
                            handle.block_on(func.wrapper.call(context.as_ref(), &params_map))
                        })
                    }
                    Err(_) => {
                        // No runtime available - use fallback runtime
                        // This handles test scenarios and standalone dispatcher usage
                        FALLBACK_RUNTIME.block_on(func.wrapper.call(context.as_ref(), &params_map))
                    }
                }
            }
            None => {
                Err(format!("RPC function '{}' not implemented", function_name))
            }
        }
    })
}
