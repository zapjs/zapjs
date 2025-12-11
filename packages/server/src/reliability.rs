//! Reliability Module for ZapJS
//!
//! Production-grade resilience patterns for IPC communication:
//! - Exponential backoff with jitter for retries
//! - Circuit breaker for cascading failure prevention
//! - Enhanced health checks with readiness/liveness probes
//!
//! ## Retry Strategy
//! Uses exponential backoff with full jitter:
//! - Base delay: 100ms
//! - Max delay: 10s
//! - Max retries: 3 (configurable)
//! - Formula: min(max_delay, base_delay * 2^attempt) * random(0, 1)
//!
//! ## Circuit Breaker States
//! - CLOSED: Normal operation, requests flow through
//! - OPEN: Too many failures, requests fail immediately
//! - HALF_OPEN: Testing if service recovered
//!
//! ## Health Check Types
//! - `/health/live`: Is the process alive? (liveness probe)
//! - `/health/ready`: Can it handle requests? (readiness probe)

use crate::connection_pool::ConnectionPool;
use crate::error::{ZapError, ZapResult};
use crate::ipc::IpcMessage;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

// ============================================================================
// Retry Configuration
// ============================================================================

/// Default base delay for exponential backoff (100ms)
const DEFAULT_BASE_DELAY_MS: u64 = 100;

/// Maximum delay cap for exponential backoff (10 seconds)
const DEFAULT_MAX_DELAY_MS: u64 = 10_000;

/// Default maximum number of retry attempts
const DEFAULT_MAX_RETRIES: usize = 3;

/// Retry configuration with exponential backoff
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Base delay for exponential backoff
    pub base_delay: Duration,
    /// Maximum delay cap
    pub max_delay: Duration,
    /// Maximum number of retry attempts (0 = no retries)
    pub max_retries: usize,
    /// Enable jitter to prevent thundering herd
    pub use_jitter: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_millis(DEFAULT_BASE_DELAY_MS),
            max_delay: Duration::from_millis(DEFAULT_MAX_DELAY_MS),
            max_retries: DEFAULT_MAX_RETRIES,
            use_jitter: true,
        }
    }
}

impl RetryConfig {
    /// Create a new retry configuration
    pub fn new() -> Self {
        Self::default()
    }

    /// Set base delay
    pub fn base_delay(mut self, delay: Duration) -> Self {
        self.base_delay = delay;
        self
    }

    /// Set maximum delay cap
    pub fn max_delay(mut self, delay: Duration) -> Self {
        self.max_delay = delay;
        self
    }

    /// Set maximum retries
    pub fn max_retries(mut self, retries: usize) -> Self {
        self.max_retries = retries;
        self
    }

    /// Enable or disable jitter
    pub fn jitter(mut self, enable: bool) -> Self {
        self.use_jitter = enable;
        self
    }

    /// Calculate delay for a given attempt (0-indexed)
    pub fn delay_for_attempt(&self, attempt: usize) -> Duration {
        // Exponential backoff: base_delay * 2^attempt
        let exp_delay_ms = self.base_delay.as_millis() as u64 * (1u64 << attempt.min(10));
        let capped_delay_ms = exp_delay_ms.min(self.max_delay.as_millis() as u64);

        if self.use_jitter {
            // Full jitter: random value between 0 and calculated delay
            let jitter = fastrand::u64(0..=capped_delay_ms);
            Duration::from_millis(jitter)
        } else {
            Duration::from_millis(capped_delay_ms)
        }
    }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

/// Circuit breaker states
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    /// Normal operation - requests flow through
    Closed,
    /// Too many failures - requests fail immediately
    Open,
    /// Testing recovery - allow limited requests
    HalfOpen,
}

impl std::fmt::Display for CircuitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CircuitState::Closed => write!(f, "CLOSED"),
            CircuitState::Open => write!(f, "OPEN"),
            CircuitState::HalfOpen => write!(f, "HALF_OPEN"),
        }
    }
}

/// Circuit breaker configuration
#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    /// Number of failures before opening circuit
    pub failure_threshold: usize,
    /// Time to wait before transitioning from OPEN to HALF_OPEN
    pub reset_timeout: Duration,
    /// Number of successes in HALF_OPEN to close circuit
    pub success_threshold: usize,
    /// Time window for counting failures
    pub failure_window: Duration,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            reset_timeout: Duration::from_secs(30),
            success_threshold: 3,
            failure_window: Duration::from_secs(60),
        }
    }
}

impl CircuitBreakerConfig {
    /// Create new circuit breaker config
    pub fn new() -> Self {
        Self::default()
    }

    /// Set failure threshold
    pub fn failure_threshold(mut self, threshold: usize) -> Self {
        self.failure_threshold = threshold;
        self
    }

    /// Set reset timeout
    pub fn reset_timeout(mut self, timeout: Duration) -> Self {
        self.reset_timeout = timeout;
        self
    }

    /// Set success threshold for half-open state
    pub fn success_threshold(mut self, threshold: usize) -> Self {
        self.success_threshold = threshold;
        self
    }

    /// Set failure counting window
    pub fn failure_window(mut self, window: Duration) -> Self {
        self.failure_window = window;
        self
    }
}

/// Circuit breaker internal state
struct CircuitBreakerState {
    state: CircuitState,
    failure_count: usize,
    success_count: usize,
    last_failure_time: Option<Instant>,
    opened_at: Option<Instant>,
}

/// Circuit breaker for protecting against cascading failures
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    state: RwLock<CircuitBreakerState>,
    /// Total failures (for metrics)
    total_failures: AtomicU64,
    /// Total successes (for metrics)
    total_successes: AtomicU64,
    /// Times circuit opened (for metrics)
    times_opened: AtomicU64,
}

impl CircuitBreaker {
    /// Create a new circuit breaker with default configuration
    pub fn new() -> Self {
        Self::with_config(CircuitBreakerConfig::default())
    }

    /// Create a new circuit breaker with custom configuration
    pub fn with_config(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            state: RwLock::new(CircuitBreakerState {
                state: CircuitState::Closed,
                failure_count: 0,
                success_count: 0,
                last_failure_time: None,
                opened_at: None,
            }),
            total_failures: AtomicU64::new(0),
            total_successes: AtomicU64::new(0),
            times_opened: AtomicU64::new(0),
        }
    }

    /// Check if a request is allowed to proceed
    pub async fn allow_request(&self) -> bool {
        let mut state = self.state.write().await;

        match state.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                // Check if reset timeout has elapsed
                if let Some(opened_at) = state.opened_at {
                    if opened_at.elapsed() >= self.config.reset_timeout {
                        info!("Circuit breaker transitioning from OPEN to HALF_OPEN");
                        state.state = CircuitState::HalfOpen;
                        state.success_count = 0;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => {
                // Allow request in half-open state
                true
            }
        }
    }

    /// Record a successful request
    pub async fn record_success(&self) {
        self.total_successes.fetch_add(1, Ordering::Relaxed);

        let mut state = self.state.write().await;

        match state.state {
            CircuitState::HalfOpen => {
                state.success_count += 1;
                if state.success_count >= self.config.success_threshold {
                    info!(
                        "Circuit breaker closing after {} successes in HALF_OPEN",
                        state.success_count
                    );
                    state.state = CircuitState::Closed;
                    state.failure_count = 0;
                    state.success_count = 0;
                    state.opened_at = None;
                }
            }
            CircuitState::Closed => {
                // Reset failure count on success (sliding window behavior)
                if let Some(last_failure) = state.last_failure_time {
                    if last_failure.elapsed() > self.config.failure_window {
                        state.failure_count = 0;
                    }
                }
            }
            CircuitState::Open => {
                // Shouldn't happen, but handle gracefully
            }
        }
    }

    /// Record a failed request
    pub async fn record_failure(&self) {
        self.total_failures.fetch_add(1, Ordering::Relaxed);

        let mut state = self.state.write().await;

        match state.state {
            CircuitState::Closed => {
                // Check if we should reset the failure window
                if let Some(last_failure) = state.last_failure_time {
                    if last_failure.elapsed() > self.config.failure_window {
                        state.failure_count = 0;
                    }
                }

                state.failure_count += 1;
                state.last_failure_time = Some(Instant::now());

                if state.failure_count >= self.config.failure_threshold {
                    warn!(
                        "Circuit breaker OPENING after {} failures",
                        state.failure_count
                    );
                    state.state = CircuitState::Open;
                    state.opened_at = Some(Instant::now());
                    self.times_opened.fetch_add(1, Ordering::Relaxed);
                }
            }
            CircuitState::HalfOpen => {
                // Any failure in half-open immediately re-opens
                warn!("Circuit breaker re-opening from HALF_OPEN after failure");
                state.state = CircuitState::Open;
                state.opened_at = Some(Instant::now());
                state.success_count = 0;
                self.times_opened.fetch_add(1, Ordering::Relaxed);
            }
            CircuitState::Open => {
                // Already open, update failure time
                state.last_failure_time = Some(Instant::now());
            }
        }
    }

    /// Get current circuit state
    pub async fn state(&self) -> CircuitState {
        self.state.read().await.state
    }

    /// Get circuit breaker statistics
    pub async fn stats(&self) -> CircuitBreakerStats {
        let state = self.state.read().await;
        CircuitBreakerStats {
            state: state.state,
            failure_count: state.failure_count,
            success_count: state.success_count,
            total_failures: self.total_failures.load(Ordering::Relaxed),
            total_successes: self.total_successes.load(Ordering::Relaxed),
            times_opened: self.times_opened.load(Ordering::Relaxed),
        }
    }

    /// Force the circuit to a specific state (for testing/admin)
    pub async fn force_state(&self, new_state: CircuitState) {
        let mut state = self.state.write().await;
        info!("Force-setting circuit breaker to {}", new_state);
        state.state = new_state;
        if new_state == CircuitState::Open {
            state.opened_at = Some(Instant::now());
        } else {
            state.opened_at = None;
        }
        state.failure_count = 0;
        state.success_count = 0;
    }
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new()
    }
}

/// Circuit breaker statistics
#[derive(Debug, Clone)]
pub struct CircuitBreakerStats {
    pub state: CircuitState,
    pub failure_count: usize,
    pub success_count: usize,
    pub total_failures: u64,
    pub total_successes: u64,
    pub times_opened: u64,
}

// ============================================================================
// Resilient IPC Client
// ============================================================================

/// Resilient IPC client with retry and circuit breaker
pub struct ResilientIpc {
    pool: Arc<ConnectionPool>,
    retry_config: RetryConfig,
    circuit_breaker: Arc<CircuitBreaker>,
}

impl ResilientIpc {
    /// Create a new resilient IPC client
    pub fn new(pool: Arc<ConnectionPool>) -> Self {
        Self {
            pool,
            retry_config: RetryConfig::default(),
            circuit_breaker: Arc::new(CircuitBreaker::new()),
        }
    }

    /// Create with custom configurations
    pub fn with_config(
        pool: Arc<ConnectionPool>,
        retry_config: RetryConfig,
        circuit_config: CircuitBreakerConfig,
    ) -> Self {
        Self {
            pool,
            retry_config,
            circuit_breaker: Arc::new(CircuitBreaker::with_config(circuit_config)),
        }
    }

    /// Send a message with retry and circuit breaker protection
    pub async fn send_recv(&self, message: IpcMessage) -> ZapResult<IpcMessage> {
        // Check circuit breaker first
        if !self.circuit_breaker.allow_request().await {
            let state = self.circuit_breaker.state().await;
            warn!("Circuit breaker is {}, rejecting request", state);
            return Err(ZapError::ipc(format!(
                "Circuit breaker is {}, service unavailable",
                state
            )));
        }

        let mut last_error: Option<ZapError> = None;

        // Attempt with retries
        for attempt in 0..=self.retry_config.max_retries {
            if attempt > 0 {
                // Calculate delay with exponential backoff
                let delay = self.retry_config.delay_for_attempt(attempt - 1);
                debug!(
                    "Retry attempt {}/{} after {:?} delay",
                    attempt, self.retry_config.max_retries, delay
                );
                tokio::time::sleep(delay).await;
            }

            match self.pool.send_recv(message.clone()).await {
                Ok(response) => {
                    // Check for error responses from TypeScript
                    if let IpcMessage::Error { code, message: _, .. } = &response {
                        // Handler errors shouldn't trigger circuit breaker
                        // (they're application-level, not infrastructure)
                        if code != "HANDLER_ERROR" && code != "VALIDATION_ERROR" {
                            self.circuit_breaker.record_failure().await;
                        } else {
                            self.circuit_breaker.record_success().await;
                        }
                        return Ok(response);
                    }

                    self.circuit_breaker.record_success().await;
                    return Ok(response);
                }
                Err(e) => {
                    warn!("IPC request failed (attempt {}): {}", attempt + 1, e);
                    last_error = Some(e);

                    // Don't retry on certain errors
                    if let Some(ref err) = last_error {
                        if is_non_retryable_error(err) {
                            break;
                        }
                    }
                }
            }
        }

        // All retries exhausted
        self.circuit_breaker.record_failure().await;
        error!(
            "IPC request failed after {} attempts",
            self.retry_config.max_retries + 1
        );

        Err(last_error.unwrap_or_else(|| ZapError::ipc("Unknown IPC error")))
    }

    /// Get the circuit breaker for monitoring
    pub fn circuit_breaker(&self) -> &Arc<CircuitBreaker> {
        &self.circuit_breaker
    }

    /// Get circuit breaker statistics
    pub async fn circuit_stats(&self) -> CircuitBreakerStats {
        self.circuit_breaker.stats().await
    }
}

/// Check if an error is non-retryable (e.g., validation errors)
fn is_non_retryable_error(error: &ZapError) -> bool {
    match error {
        ZapError::Validation { .. } => true,
        ZapError::Unauthorized { .. } => true,
        ZapError::Forbidden { .. } => true,
        ZapError::RateLimited { .. } => true,
        _ => false,
    }
}

// ============================================================================
// Enhanced Health Checks
// ============================================================================

/// Health check status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

impl std::fmt::Display for HealthStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HealthStatus::Healthy => write!(f, "healthy"),
            HealthStatus::Degraded => write!(f, "degraded"),
            HealthStatus::Unhealthy => write!(f, "unhealthy"),
        }
    }
}

/// Component health information
#[derive(Debug, Clone)]
pub struct ComponentHealth {
    pub name: String,
    pub status: HealthStatus,
    pub message: Option<String>,
    pub latency_ms: Option<u64>,
}

/// Complete health check response
#[derive(Debug, Clone)]
pub struct HealthCheckResponse {
    /// Overall status
    pub status: HealthStatus,
    /// Individual component health
    pub components: Vec<ComponentHealth>,
    /// Server version
    pub version: String,
    /// Server uptime in seconds
    pub uptime_secs: u64,
}

impl HealthCheckResponse {
    /// Convert to JSON
    pub fn to_json(&self) -> String {
        let components_json: Vec<String> = self
            .components
            .iter()
            .map(|c| {
                let msg = c
                    .message
                    .as_ref()
                    .map(|m| format!(r#","message":"{}""#, m))
                    .unwrap_or_default();
                let latency = c
                    .latency_ms
                    .map(|l| format!(r#","latency_ms":{}"#, l))
                    .unwrap_or_default();
                format!(
                    r#"{{"name":"{}","status":"{}"{}{}}}"#,
                    c.name, c.status, msg, latency
                )
            })
            .collect();

        format!(
            r#"{{"status":"{}","version":"{}","uptime_secs":{},"components":[{}]}}"#,
            self.status,
            self.version,
            self.uptime_secs,
            components_json.join(",")
        )
    }
}

/// Health checker for the ZapJS server
pub struct HealthChecker {
    start_time: Instant,
    version: String,
    pool: Option<Arc<ConnectionPool>>,
    circuit_breaker: Option<Arc<CircuitBreaker>>,
}

impl HealthChecker {
    /// Create a new health checker
    pub fn new(version: String) -> Self {
        Self {
            start_time: Instant::now(),
            version,
            pool: None,
            circuit_breaker: None,
        }
    }

    /// Set the connection pool to monitor
    pub fn with_pool(mut self, pool: Arc<ConnectionPool>) -> Self {
        self.pool = Some(pool);
        self
    }

    /// Set the circuit breaker to monitor
    pub fn with_circuit_breaker(mut self, cb: Arc<CircuitBreaker>) -> Self {
        self.circuit_breaker = Some(cb);
        self
    }

    /// Liveness probe: Is the process alive?
    /// This should always return true if the server can respond at all.
    pub fn liveness(&self) -> HealthCheckResponse {
        HealthCheckResponse {
            status: HealthStatus::Healthy,
            components: vec![ComponentHealth {
                name: "process".to_string(),
                status: HealthStatus::Healthy,
                message: Some("Server is running".to_string()),
                latency_ms: None,
            }],
            version: self.version.clone(),
            uptime_secs: self.start_time.elapsed().as_secs(),
        }
    }

    /// Readiness probe: Can the server handle requests?
    /// Checks connection pool and circuit breaker state.
    pub async fn readiness(&self) -> HealthCheckResponse {
        let mut components = Vec::new();
        let mut overall_status = HealthStatus::Healthy;

        // Check connection pool
        if let Some(pool) = &self.pool {
            let start = Instant::now();
            let (healthy, total) = pool.health_check().await;
            let latency = start.elapsed().as_millis() as u64;

            let pool_status = if healthy == total {
                HealthStatus::Healthy
            } else if healthy > 0 {
                overall_status = HealthStatus::Degraded;
                HealthStatus::Degraded
            } else {
                overall_status = HealthStatus::Unhealthy;
                HealthStatus::Unhealthy
            };

            components.push(ComponentHealth {
                name: "connection_pool".to_string(),
                status: pool_status,
                message: Some(format!("{}/{} connections healthy", healthy, total)),
                latency_ms: Some(latency),
            });
        }

        // Check circuit breaker
        if let Some(cb) = &self.circuit_breaker {
            let state = cb.state().await;
            let cb_status = match state {
                CircuitState::Closed => HealthStatus::Healthy,
                CircuitState::HalfOpen => {
                    if overall_status == HealthStatus::Healthy {
                        overall_status = HealthStatus::Degraded;
                    }
                    HealthStatus::Degraded
                }
                CircuitState::Open => {
                    overall_status = HealthStatus::Unhealthy;
                    HealthStatus::Unhealthy
                }
            };

            components.push(ComponentHealth {
                name: "circuit_breaker".to_string(),
                status: cb_status,
                message: Some(format!("Circuit is {}", state)),
                latency_ms: None,
            });
        }

        // If no components configured, assume healthy
        if components.is_empty() {
            components.push(ComponentHealth {
                name: "server".to_string(),
                status: HealthStatus::Healthy,
                message: Some("No components configured".to_string()),
                latency_ms: None,
            });
        }

        HealthCheckResponse {
            status: overall_status,
            components,
            version: self.version.clone(),
            uptime_secs: self.start_time.elapsed().as_secs(),
        }
    }

    /// Get uptime in seconds
    pub fn uptime_secs(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_config_default() {
        let config = RetryConfig::default();
        assert_eq!(config.max_retries, DEFAULT_MAX_RETRIES);
        assert_eq!(config.base_delay, Duration::from_millis(DEFAULT_BASE_DELAY_MS));
        assert!(config.use_jitter);
    }

    #[test]
    fn test_retry_config_builder() {
        let config = RetryConfig::new()
            .max_retries(5)
            .base_delay(Duration::from_millis(200))
            .max_delay(Duration::from_secs(5))
            .jitter(false);

        assert_eq!(config.max_retries, 5);
        assert_eq!(config.base_delay, Duration::from_millis(200));
        assert_eq!(config.max_delay, Duration::from_secs(5));
        assert!(!config.use_jitter);
    }

    #[test]
    fn test_exponential_backoff_without_jitter() {
        let config = RetryConfig::new()
            .base_delay(Duration::from_millis(100))
            .max_delay(Duration::from_secs(10))
            .jitter(false);

        // 100ms * 2^0 = 100ms
        assert_eq!(config.delay_for_attempt(0), Duration::from_millis(100));
        // 100ms * 2^1 = 200ms
        assert_eq!(config.delay_for_attempt(1), Duration::from_millis(200));
        // 100ms * 2^2 = 400ms
        assert_eq!(config.delay_for_attempt(2), Duration::from_millis(400));
        // 100ms * 2^3 = 800ms
        assert_eq!(config.delay_for_attempt(3), Duration::from_millis(800));
    }

    #[test]
    fn test_exponential_backoff_with_cap() {
        let config = RetryConfig::new()
            .base_delay(Duration::from_millis(1000))
            .max_delay(Duration::from_millis(5000))
            .jitter(false);

        // 1000ms * 2^0 = 1000ms
        assert_eq!(config.delay_for_attempt(0), Duration::from_millis(1000));
        // 1000ms * 2^1 = 2000ms
        assert_eq!(config.delay_for_attempt(1), Duration::from_millis(2000));
        // 1000ms * 2^2 = 4000ms
        assert_eq!(config.delay_for_attempt(2), Duration::from_millis(4000));
        // 1000ms * 2^3 = 8000ms, capped to 5000ms
        assert_eq!(config.delay_for_attempt(3), Duration::from_millis(5000));
    }

    #[test]
    fn test_circuit_breaker_config_default() {
        let config = CircuitBreakerConfig::default();
        assert_eq!(config.failure_threshold, 5);
        assert_eq!(config.reset_timeout, Duration::from_secs(30));
        assert_eq!(config.success_threshold, 3);
    }

    #[test]
    fn test_circuit_breaker_config_builder() {
        let config = CircuitBreakerConfig::new()
            .failure_threshold(10)
            .reset_timeout(Duration::from_secs(60))
            .success_threshold(5);

        assert_eq!(config.failure_threshold, 10);
        assert_eq!(config.reset_timeout, Duration::from_secs(60));
        assert_eq!(config.success_threshold, 5);
    }

    #[tokio::test]
    async fn test_circuit_breaker_initial_state() {
        let cb = CircuitBreaker::new();
        assert_eq!(cb.state().await, CircuitState::Closed);
        assert!(cb.allow_request().await);
    }

    #[tokio::test]
    async fn test_circuit_breaker_opens_after_failures() {
        let config = CircuitBreakerConfig::new()
            .failure_threshold(3)
            .failure_window(Duration::from_secs(60));
        let cb = CircuitBreaker::with_config(config);

        // Record 3 failures
        cb.record_failure().await;
        assert_eq!(cb.state().await, CircuitState::Closed);
        cb.record_failure().await;
        assert_eq!(cb.state().await, CircuitState::Closed);
        cb.record_failure().await;
        assert_eq!(cb.state().await, CircuitState::Open);

        // Should reject requests
        assert!(!cb.allow_request().await);
    }

    #[tokio::test]
    async fn test_circuit_breaker_half_open_recovery() {
        let config = CircuitBreakerConfig::new()
            .failure_threshold(2)
            .success_threshold(2)
            .reset_timeout(Duration::from_millis(10));
        let cb = CircuitBreaker::with_config(config);

        // Open the circuit
        cb.record_failure().await;
        cb.record_failure().await;
        assert_eq!(cb.state().await, CircuitState::Open);

        // Wait for reset timeout
        tokio::time::sleep(Duration::from_millis(15)).await;

        // Should transition to half-open
        assert!(cb.allow_request().await);
        assert_eq!(cb.state().await, CircuitState::HalfOpen);

        // Record successes to close
        cb.record_success().await;
        assert_eq!(cb.state().await, CircuitState::HalfOpen);
        cb.record_success().await;
        assert_eq!(cb.state().await, CircuitState::Closed);
    }

    #[tokio::test]
    async fn test_circuit_breaker_stats() {
        let cb = CircuitBreaker::new();

        cb.record_success().await;
        cb.record_success().await;
        cb.record_failure().await;

        let stats = cb.stats().await;
        assert_eq!(stats.total_successes, 2);
        assert_eq!(stats.total_failures, 1);
        assert_eq!(stats.state, CircuitState::Closed);
    }

    #[test]
    fn test_health_status_display() {
        assert_eq!(format!("{}", HealthStatus::Healthy), "healthy");
        assert_eq!(format!("{}", HealthStatus::Degraded), "degraded");
        assert_eq!(format!("{}", HealthStatus::Unhealthy), "unhealthy");
    }

    #[test]
    fn test_health_checker_liveness() {
        let checker = HealthChecker::new("1.0.0".to_string());
        let response = checker.liveness();

        assert_eq!(response.status, HealthStatus::Healthy);
        assert_eq!(response.version, "1.0.0");
        assert!(!response.components.is_empty());
    }

    #[tokio::test]
    async fn test_health_checker_readiness_no_components() {
        let checker = HealthChecker::new("1.0.0".to_string());
        let response = checker.readiness().await;

        assert_eq!(response.status, HealthStatus::Healthy);
    }

    #[test]
    fn test_health_response_json() {
        let response = HealthCheckResponse {
            status: HealthStatus::Healthy,
            components: vec![ComponentHealth {
                name: "test".to_string(),
                status: HealthStatus::Healthy,
                message: Some("OK".to_string()),
                latency_ms: Some(5),
            }],
            version: "1.0.0".to_string(),
            uptime_secs: 100,
        };

        let json = response.to_json();
        assert!(json.contains(r#""status":"healthy""#));
        assert!(json.contains(r#""version":"1.0.0""#));
        assert!(json.contains(r#""uptime_secs":100"#));
        assert!(json.contains(r#""name":"test""#));
    }
}
