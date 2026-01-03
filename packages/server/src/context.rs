//! Request execution context for exported functions
//!
//! This module provides the `Context` type that gives user-exported functions
//! access to request metadata like trace IDs, headers, and authentication information.

use splice::protocol::{RequestContext, AuthContext};

/// Request execution context available to exported functions
///
/// Provides access to request metadata like trace IDs, headers, and authentication.
/// This is an optional parameter for exported functions - functions can choose to
/// accept a `Context` parameter as their first argument to access request metadata.
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
/// ```
#[derive(Debug, Clone)]
pub struct Context {
    inner: RequestContext,
}

impl Context {
    /// Create context from protocol RequestContext
    ///
    /// This is an internal constructor used by the runtime to wrap
    /// the protocol-level RequestContext in the user-facing Context type.
    #[doc(hidden)]
    pub fn new(inner: RequestContext) -> Self {
        Self { inner }
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
}
