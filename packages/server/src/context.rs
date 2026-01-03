//! Request execution context for exported functions
//!
//! This module provides the `Context` type that gives user-exported functions
//! access to request metadata like trace IDs, headers, and authentication information.

use splice::protocol::{RequestContext, AuthContext};
use tokio_util::sync::CancellationToken;

/// Request execution context available to exported functions
///
/// Provides access to request metadata like trace IDs, headers, and authentication.
/// This is an optional parameter for exported functions - functions can choose to
/// accept a `Context` parameter as their first argument to access request metadata.
///
/// # Cancellation Support
///
/// The context includes a cancellation token that allows long-running functions to
/// cooperatively handle cancellation (e.g., due to timeout or client disconnect).
///
/// # Example
/// ```ignore
/// use zap_server::{export, Context};
///
/// #[export]
/// pub fn my_function(ctx: Context, data: String) -> String {
///     let trace_id = ctx.trace_id();
///     let user = ctx.user_id().unwrap_or("anonymous");
///
///     if let Some(api_key) = ctx.header("x-api-key") {
///         // Use API key for authentication
///     }
///
///     format!("Processed by {} (trace: {})", user, trace_id)
/// }
///
/// #[export]
/// pub async fn long_task(ctx: &Context, data: Vec<u64>) -> Result<u64, String> {
///     let mut sum = 0;
///     for (i, &n) in data.iter().enumerate() {
///         // Check for cancellation periodically
///         if i % 1000 == 0 && ctx.is_cancelled() {
///             return Err("Request cancelled".to_string());
///         }
///         sum += n;
///     }
///     Ok(sum)
/// }
/// ```
#[derive(Debug, Clone)]
pub struct Context {
    inner: RequestContext,
    cancellation_token: CancellationToken,
}

impl Context {
    /// Create context from protocol RequestContext
    ///
    /// This is an internal constructor used by the runtime to wrap
    /// the protocol-level RequestContext in the user-facing Context type.
    /// Creates a fresh cancellation token.
    #[doc(hidden)]
    pub fn new(inner: RequestContext) -> Self {
        Self {
            inner,
            cancellation_token: CancellationToken::new(),
        }
    }

    /// Create context with a specific cancellation token
    ///
    /// This is used by the worker to create contexts with tokens that can be
    /// triggered when Cancel messages are received.
    #[doc(hidden)]
    pub fn with_cancellation(inner: RequestContext, token: CancellationToken) -> Self {
        Self {
            inner,
            cancellation_token: token,
        }
    }

    /// Get the distributed trace ID for this request
    ///
    /// Useful for correlating logs and spans across services in a distributed system.
    /// The trace ID is propagated from the HTTP request and can be used for observability.
    ///
    /// # Example
    /// ```ignore
    /// let trace_id = ctx.trace_id();
    /// tracing::info!(trace_id = trace_id, "Processing request");
    /// ```
    pub fn trace_id(&self) -> u64 {
        self.inner.trace_id
    }

    /// Get the span ID for this function invocation
    ///
    /// The span ID identifies this specific operation within the larger trace.
    /// Use this for detailed distributed tracing.
    pub fn span_id(&self) -> u64 {
        self.inner.span_id
    }

    /// Get a request header by name (case-insensitive)
    ///
    /// Returns `None` if the header is not present.
    ///
    /// # Example
    /// ```ignore
    /// if let Some(content_type) = ctx.header("content-type") {
    ///     println!("Content-Type: {}", content_type);
    /// }
    /// ```
    pub fn header(&self, name: &str) -> Option<&str> {
        let name_lower = name.to_lowercase();
        self.inner.headers
            .iter()
            .find(|(k, _)| k.to_lowercase() == name_lower)
            .map(|(_, v)| v.as_str())
    }

    /// Get all request headers
    ///
    /// Returns a slice of (name, value) tuples for all HTTP headers
    /// that were present in the original request.
    pub fn headers(&self) -> &[(String, String)] {
        &self.inner.headers
    }

    /// Get authentication context if request is authenticated
    ///
    /// Returns `None` if the request was not authenticated.
    /// The authentication context includes user ID and roles.
    pub fn auth(&self) -> Option<&AuthContext> {
        self.inner.auth.as_ref()
    }

    /// Get authenticated user ID
    ///
    /// Returns `None` if the request is not authenticated.
    ///
    /// # Example
    /// ```ignore
    /// if let Some(user_id) = ctx.user_id() {
    ///     println!("Request from user: {}", user_id);
    /// }
    /// ```
    pub fn user_id(&self) -> Option<&str> {
        self.auth().map(|a| a.user_id.as_str())
    }

    /// Check if authenticated user has a specific role
    ///
    /// Returns `false` if the request is not authenticated.
    ///
    /// # Example
    /// ```ignore
    /// if ctx.has_role("admin") {
    ///     // Perform admin operation
    /// } else {
    ///     return Err("Unauthorized".to_string());
    /// }
    /// ```
    pub fn has_role(&self, role: &str) -> bool {
        self.auth()
            .map(|a| a.roles.contains(&role.to_string()))
            .unwrap_or(false)
    }

    /// Check if this request has been cancelled
    ///
    /// Returns `true` if the request was cancelled (e.g., due to timeout or client disconnect).
    /// Long-running functions should periodically check this and return early if cancelled.
    ///
    /// Cancellation is **cooperative** - functions must explicitly check and respond to it.
    /// Functions that don't check will continue running even after cancellation.
    ///
    /// # Example
    /// ```ignore
    /// #[export]
    /// pub async fn long_computation(ctx: &Context, data: Vec<u64>) -> Result<u64, String> {
    ///     let mut sum = 0;
    ///     for (i, chunk) in data.chunks(1000).enumerate() {
    ///         // Check every 1000 items
    ///         if ctx.is_cancelled() {
    ///             return Err("Request cancelled".to_string());
    ///         }
    ///         sum += chunk.iter().sum::<u64>();
    ///     }
    ///     Ok(sum)
    /// }
    /// ```
    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token.is_cancelled()
    }

    /// Get a future that completes when the request is cancelled
    ///
    /// This can be used with `tokio::select!` for automatic cancellation handling.
    /// The returned future will complete when the cancellation token is triggered.
    ///
    /// # Example
    /// ```ignore
    /// #[export]
    /// pub async fn interruptible_work(ctx: &Context) -> Result<String, String> {
    ///     tokio::select! {
    ///         result = expensive_database_query() => Ok(result),
    ///         _ = ctx.cancelled() => Err("Request cancelled".to_string()),
    ///     }
    /// }
    /// ```
    pub async fn cancelled(&self) {
        self.cancellation_token.cancelled().await
    }
}
