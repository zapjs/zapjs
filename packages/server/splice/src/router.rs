use crate::protocol::{Message, ErrorKind, ExportMetadata, ERR_TIMEOUT, ERR_OVERLOADED, ERR_CANCELLED};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::timeout;
use tracing::{debug, warn};

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("Request timeout")]
    Timeout,

    #[error("System overloaded")]
    Overloaded,

    #[error("Request cancelled")]
    Cancelled,

    #[error("Worker not available")]
    WorkerUnavailable,

    #[error("Execution error: {0}")]
    ExecutionError(String),
}

#[derive(Debug, Clone)]
pub struct RouterConfig {
    pub max_concurrent_requests: usize,
    pub max_concurrent_per_function: usize,
    pub default_timeout: Duration,
}

impl Default for RouterConfig {
    fn default() -> Self {
        Self {
            max_concurrent_requests: 1024,
            max_concurrent_per_function: 100,
            default_timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug)]
struct PendingRequest {
    function_name: String,
    started_at: Instant,
    response_tx: oneshot::Sender<Message>,
}

pub struct Router {
    config: RouterConfig,
    exports: Arc<RwLock<HashMap<String, ExportMetadata>>>,
    pending: Arc<RwLock<HashMap<u64, PendingRequest>>>,
    function_counts: Arc<RwLock<HashMap<String, usize>>>,
    next_request_id: Arc<RwLock<u64>>,
    worker_tx: Option<mpsc::Sender<Message>>,
}

impl Router {
    pub fn new(config: RouterConfig) -> Self {
        Self {
            config,
            exports: Arc::new(RwLock::new(HashMap::new())),
            pending: Arc::new(RwLock::new(HashMap::new())),
            function_counts: Arc::new(RwLock::new(HashMap::new())),
            next_request_id: Arc::new(RwLock::new(1)),
            worker_tx: None,
        }
    }

    pub fn set_worker_tx(&mut self, tx: mpsc::Sender<Message>) {
        self.worker_tx = Some(tx);
    }

    pub async fn update_exports(&self, exports: Vec<ExportMetadata>) {
        let mut map = self.exports.write().await;
        map.clear();
        for export in exports {
            map.insert(export.name.clone(), export);
        }
    }

    pub async fn get_exports(&self) -> Vec<ExportMetadata> {
        self.exports.read().await.values().cloned().collect()
    }

    pub async fn invoke(
        &self,
        function_name: String,
        params: Bytes,
        deadline_ms: u32,
        context: crate::protocol::RequestContext,
    ) -> Result<Bytes, RouterError> {
        // Check global concurrency limit
        let pending_count = self.pending.read().await.len();
        if pending_count >= self.config.max_concurrent_requests {
            warn!(
                "Global concurrency limit exceeded: {}/{}",
                pending_count, self.config.max_concurrent_requests
            );
            return Err(RouterError::Overloaded);
        }

        // Check per-function concurrency limit
        {
            let counts = self.function_counts.read().await;
            let func_count = counts.get(&function_name).copied().unwrap_or(0);
            if func_count >= self.config.max_concurrent_per_function {
                warn!(
                    "Function concurrency limit exceeded for '{}': {}/{}",
                    function_name, func_count, self.config.max_concurrent_per_function
                );
                return Err(RouterError::Overloaded);
            }
        }

        // Allocate request ID
        let request_id = {
            let mut next_id = self.next_request_id.write().await;
            let id = *next_id;
            *next_id = next_id.wrapping_add(1);
            id
        };

        // Create response channel
        let (response_tx, response_rx) = oneshot::channel();

        // Register pending request
        {
            let mut pending = self.pending.write().await;
            pending.insert(
                request_id,
                PendingRequest {
                    function_name: function_name.clone(),
                    started_at: Instant::now(),
                    response_tx,
                },
            );
        }

        // Increment function counter
        {
            let mut counts = self.function_counts.write().await;
            *counts.entry(function_name.clone()).or_insert(0) += 1;
        }

        // Send invoke message to worker
        let worker_tx = self.worker_tx.as_ref()
            .ok_or(RouterError::WorkerUnavailable)?;

        let invoke_msg = Message::Invoke {
            request_id,
            function_name: function_name.clone(),
            params,
            deadline_ms,
            context,
        };

        if worker_tx.send(invoke_msg).await.is_err() {
            self.cleanup_request(request_id).await;
            return Err(RouterError::WorkerUnavailable);
        }

        // Wait for response with timeout
        let timeout_duration = if deadline_ms > 0 {
            Duration::from_millis(deadline_ms as u64)
        } else {
            self.config.default_timeout
        };

        let result = timeout(timeout_duration, response_rx).await;

        match result {
            Ok(Ok(msg)) => {
                self.cleanup_request(request_id).await;
                match msg {
                    Message::InvokeResult { result, .. } => Ok(result),
                    Message::InvokeError { message, .. } => {
                        Err(RouterError::ExecutionError(message))
                    }
                    _ => Err(RouterError::WorkerUnavailable),
                }
            }
            Ok(Err(_)) => {
                // Response channel dropped
                self.cleanup_request(request_id).await;
                Err(RouterError::WorkerUnavailable)
            }
            Err(_) => {
                // Timeout
                self.send_cancel(request_id).await;
                self.cleanup_request(request_id).await;
                Err(RouterError::Timeout)
            }
        }
    }

    pub async fn handle_worker_message(&self, msg: Message) {
        match msg {
            Message::InvokeResult { request_id, .. }
            | Message::InvokeError { request_id, .. } => {
                if let Some(pending) = self.pending.write().await.remove(&request_id) {
                    let _ = pending.response_tx.send(msg);
                }
            }
            _ => {
                debug!("Unhandled worker message: {:?}", msg);
            }
        }
    }

    async fn send_cancel(&self, request_id: u64) {
        if let Some(ref worker_tx) = self.worker_tx {
            let cancel_msg = Message::Cancel { request_id };
            let _ = worker_tx.send(cancel_msg).await;
        }
    }

    async fn cleanup_request(&self, request_id: u64) {
        if let Some(pending) = self.pending.write().await.remove(&request_id) {
            let mut counts = self.function_counts.write().await;
            if let Some(count) = counts.get_mut(&pending.function_name) {
                *count = count.saturating_sub(1);
            }
        }
    }

    pub async fn drain(&self, timeout_duration: Duration) {
        let start = Instant::now();

        loop {
            let pending_count = self.pending.read().await.len();
            if pending_count == 0 {
                debug!("All requests drained");
                break;
            }

            if start.elapsed() > timeout_duration {
                warn!("Drain timeout exceeded, {} requests still pending", pending_count);
                break;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_router_config_default() {
        let config = RouterConfig::default();
        assert_eq!(config.max_concurrent_requests, 1024);
        assert_eq!(config.max_concurrent_per_function, 100);
    }
}
