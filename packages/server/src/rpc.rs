//! RPC Server for TypeScript → Rust function calls via IPC
//!
//! This module implements a production-ready RPC server that listens on a Unix domain socket
//! for remote procedure calls from TypeScript handlers. The TypeScript RPC client sends
//! function names and parameters, and this server dispatches them to user-defined Rust functions.
//!
//! ## Architecture
//!
//! - **Socket Path**: `{ipc_socket_path}.rpc` (e.g., `/tmp/zap-dev-123.sock.rpc`)
//! - **Protocol**: Length-prefixed MessagePack/JSON messages
//! - **Encoding**: MessagePack by default, JSON fallback for debugging
//! - **Concurrency**: Each connection handled in separate Tokio task
//!
//! ## Message Format
//!
//! ### RPC Call (TypeScript → Rust)
//! ```json
//! {
//!   "type": "rpc_call",
//!   "function_name": "get_benchmarks",
//!   "params": {},
//!   "request_id": "req_1234567890_0"
//! }
//! ```
//!
//! ### RPC Response (Rust → TypeScript)
//! ```json
//! {
//!   "type": "rpc_response",
//!   "request_id": "req_1234567890_0",
//!   "result": { "data": "..." }
//! }
//! ```
//!
//! ### RPC Error (Rust → TypeScript)
//! ```json
//! {
//!   "type": "rpc_error",
//!   "request_id": "req_1234567890_0",
//!   "error": "Unknown function",
//!   "error_type": "RpcError"
//! }
//! ```

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{debug, error, info, warn};

use crate::error::{ZapError, ZapResult};

/// User-provided RPC dispatch function
///
/// Takes (function_name, params) and returns Result<data, error_message>
/// Using serde_json::Value for maximum flexibility - users can deserialize in their dispatch
pub type RpcDispatchFn = Arc<dyn Fn(String, serde_json::Value) -> Result<serde_json::Value, String> + Send + Sync + 'static>;

/// RPC call message from TypeScript
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcCallMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub function_name: String,
    pub params: serde_json::Value,
    pub request_id: String,
}

/// RPC success response to TypeScript
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponseMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub request_id: String,
    pub result: serde_json::Value,
}

/// RPC error response to TypeScript
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub request_id: String,
    pub error: String,
    pub error_type: String,
}

/// Internal RPC message enum for type-safe handling
#[derive(Debug)]
enum RpcMessage {
    Response(RpcResponseMessage),
    Error(RpcErrorMessage),
}

/// Handle to the RPC server (for lifecycle management)
pub struct RpcServerHandle {
    socket_path: String,
    dispatch_fn: RpcDispatchFn,
}

impl RpcServerHandle {
    /// Create a new RPC server handle
    pub fn new(socket_path: String, dispatch_fn: RpcDispatchFn) -> Self {
        Self {
            socket_path,
            dispatch_fn,
        }
    }

    /// Start the RPC server in the background
    ///
    /// Creates a Unix domain socket at `{socket_path}.rpc` and spawns a background
    /// task to accept connections and handle RPC calls.
    ///
    /// # Errors
    ///
    /// Returns an error if the socket cannot be bound (e.g., permission denied,
    /// address already in use).
    pub async fn start(self) -> ZapResult<()> {
        let rpc_socket_path = format!("{}.rpc", self.socket_path);

        // Remove existing socket file if it exists
        let _ = std::fs::remove_file(&rpc_socket_path);

        // Bind to Unix socket
        let listener = tokio::net::UnixListener::bind(&rpc_socket_path)
            .map_err(|e| ZapError::ipc(format!("Failed to bind RPC socket at {}: {}", rpc_socket_path, e)))?;

        info!("🔧 RPC server listening on {}", rpc_socket_path);

        let dispatch_fn = self.dispatch_fn;

        // Spawn background task to accept connections
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let dispatch_fn = dispatch_fn.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_rpc_connection(stream, dispatch_fn).await {
                                error!("RPC connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("RPC accept error: {}", e);
                        break;
                    }
                }
            }
        });

        Ok(())
    }
}

/// Handle a single RPC client connection
///
/// Reads messages from the Unix socket, dispatches RPC calls, and sends responses.
/// Runs in a loop until the client disconnects or an error occurs.
async fn handle_rpc_connection(
    stream: tokio::net::UnixStream,
    dispatch_fn: RpcDispatchFn,
) -> ZapResult<()> {
    let mut stream = stream;

    loop {
        // Read 4-byte big-endian length prefix
        let mut len_buf = [0u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                debug!("RPC client disconnected");
                return Ok(());
            }
            Err(e) => {
                return Err(ZapError::ipc(format!("Failed to read message length: {}", e)));
            }
        }

        let len = u32::from_be_bytes(len_buf) as usize;

        // Sanity check: reject messages larger than 100MB
        if len > 100 * 1024 * 1024 {
            return Err(ZapError::ipc(format!("Message too large: {} bytes", len)));
        }

        // Read payload
        let mut buffer = vec![0u8; len];
        stream
            .read_exact(&mut buffer)
            .await
            .map_err(|e| ZapError::ipc(format!("Failed to read message payload: {}", e)))?;

        // Deserialize RPC call (auto-detect MessagePack or JSON)
        let call = deserialize_rpc_message(&buffer)?;

        // Dispatch RPC call to user function
        let response_msg = dispatch_rpc_call(&call, &dispatch_fn);

        // Serialize response
        let response_bytes = serialize_rpc_message(&response_msg)?;

        // Write length prefix + payload (atomic frame)
        let frame_len = response_bytes.len() as u32;
        let mut frame = Vec::with_capacity(4 + response_bytes.len());
        frame.extend_from_slice(&frame_len.to_be_bytes());
        frame.extend_from_slice(&response_bytes);

        stream
            .write_all(&frame)
            .await
            .map_err(|e| ZapError::ipc(format!("Failed to write response: {}", e)))?;

        stream
            .flush()
            .await
            .map_err(|e| ZapError::ipc(format!("Failed to flush response: {}", e)))?;
    }
}

/// Dispatch an RPC call to the user's dispatch function
fn dispatch_rpc_call(call: &RpcCallMessage, dispatch_fn: &RpcDispatchFn) -> RpcMessage {
    debug!(
        "RPC: {} (request_id: {}) with params {:?}",
        call.function_name, call.request_id, call.params
    );

    let start = std::time::Instant::now();

    match dispatch_fn(call.function_name.clone(), call.params.clone()) {
        Ok(result) => {
            let duration = start.elapsed();
            debug!(
                "RPC: {} completed in {:?} (request_id: {})",
                call.function_name, duration, call.request_id
            );

            RpcMessage::Response(RpcResponseMessage {
                msg_type: "rpc_response".to_string(),
                request_id: call.request_id.clone(),
                result,
            })
        }
        Err(error) => {
            let duration = start.elapsed();
            warn!(
                "RPC: {} failed in {:?}: {} (request_id: {})",
                call.function_name, duration, error, call.request_id
            );

            RpcMessage::Error(RpcErrorMessage {
                msg_type: "rpc_error".to_string(),
                request_id: call.request_id.clone(),
                error,
                error_type: "RpcError".to_string(),
            })
        }
    }
}

/// Deserialize RPC message with auto-detection of MessagePack or JSON
fn deserialize_rpc_message(data: &[u8]) -> ZapResult<RpcCallMessage> {
    if data.is_empty() {
        return Err(ZapError::ipc("Empty RPC message"));
    }

    // Auto-detect encoding based on first byte
    let first_byte = data[0];

    if first_byte == b'{' {
        // JSON format (starts with '{')
        serde_json::from_slice(data)
            .map_err(|e| ZapError::ipc(format!("Failed to deserialize JSON RPC message: {}", e)))
    } else {
        // MessagePack format (binary)
        rmp_serde::from_slice(data)
            .map_err(|e| ZapError::ipc(format!("Failed to deserialize MessagePack RPC message: {}", e)))
    }
}

/// Serialize RPC message to MessagePack format
fn serialize_rpc_message(msg: &RpcMessage) -> ZapResult<Vec<u8>> {
    let serializable = match msg {
        RpcMessage::Response(resp) => serde_json::to_value(resp)
            .map_err(|e| ZapError::ipc(format!("Failed to convert response to JSON value: {}", e)))?,
        RpcMessage::Error(err) => serde_json::to_value(err)
            .map_err(|e| ZapError::ipc(format!("Failed to convert error to JSON value: {}", e)))?,
    };

    // Use MessagePack with named fields for compatibility with TypeScript @msgpack/msgpack
    rmp_serde::to_vec_named(&serializable)
        .map_err(|e| ZapError::ipc(format!("Failed to serialize RPC message to MessagePack: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ============================================================================
    // Message Serialization Tests
    // ============================================================================

    #[test]
    fn test_rpc_call_json_serialization() {
        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "get_benchmarks".to_string(),
            params: json!({"limit": 10, "offset": 0}),
            request_id: "req_123".to_string(),
        };

        let json_bytes = serde_json::to_vec(&call).unwrap();
        let decoded: RpcCallMessage = serde_json::from_slice(&json_bytes).unwrap();

        assert_eq!(decoded.msg_type, "rpc_call");
        assert_eq!(decoded.function_name, "get_benchmarks");
        assert_eq!(decoded.request_id, "req_123");
        assert_eq!(decoded.params["limit"], 10);
        assert_eq!(decoded.params["offset"], 0);
    }

    #[test]
    fn test_rpc_response_json_serialization() {
        let response = RpcResponseMessage {
            msg_type: "rpc_response".to_string(),
            request_id: "req_456".to_string(),
            result: json!({"data": [1, 2, 3], "count": 3}),
        };

        let json_bytes = serde_json::to_vec(&response).unwrap();
        let decoded: RpcResponseMessage = serde_json::from_slice(&json_bytes).unwrap();

        assert_eq!(decoded.msg_type, "rpc_response");
        assert_eq!(decoded.request_id, "req_456");
        assert_eq!(decoded.result["count"], 3);
        assert_eq!(decoded.result["data"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_rpc_error_json_serialization() {
        let error = RpcErrorMessage {
            msg_type: "rpc_error".to_string(),
            request_id: "req_789".to_string(),
            error: "Function not found".to_string(),
            error_type: "NotFound".to_string(),
        };

        let json_bytes = serde_json::to_vec(&error).unwrap();
        let decoded: RpcErrorMessage = serde_json::from_slice(&json_bytes).unwrap();

        assert_eq!(decoded.msg_type, "rpc_error");
        assert_eq!(decoded.request_id, "req_789");
        assert_eq!(decoded.error, "Function not found");
        assert_eq!(decoded.error_type, "NotFound");
    }

    #[test]
    fn test_messagepack_vs_json_size() {
        let response = RpcMessage::Response(RpcResponseMessage {
            msg_type: "rpc_response".to_string(),
            request_id: "req_benchmark_001".to_string(),
            result: json!({
                "benchmarks": [
                    {"name": "test1", "duration": 100, "throughput": 1000},
                    {"name": "test2", "duration": 200, "throughput": 2000},
                    {"name": "test3", "duration": 300, "throughput": 3000},
                ],
                "total": 3,
                "timestamp": "2024-01-01T00:00:00Z"
            }),
        });

        let msgpack_bytes = serialize_rpc_message(&response).unwrap();
        let json_bytes = serde_json::to_vec(&json!({
            "type": "rpc_response",
            "request_id": "req_benchmark_001",
            "result": {
                "benchmarks": [
                    {"name": "test1", "duration": 100, "throughput": 1000},
                    {"name": "test2", "duration": 200, "throughput": 2000},
                    {"name": "test3", "duration": 300, "throughput": 3000},
                ],
                "total": 3,
                "timestamp": "2024-01-01T00:00:00Z"
            }
        }))
        .unwrap();

        // MessagePack should be more compact for structured data
        assert!(
            msgpack_bytes.len() < json_bytes.len(),
            "MessagePack ({} bytes) should be smaller than JSON ({} bytes)",
            msgpack_bytes.len(),
            json_bytes.len()
        );
    }

    #[test]
    fn test_deserialize_json_rpc_call() {
        let json_data = r#"{
            "type": "rpc_call",
            "function_name": "list_users",
            "params": {"limit": 50, "offset": 100},
            "request_id": "req_test_001"
        }"#;

        let call = deserialize_rpc_message(json_data.as_bytes()).unwrap();

        assert_eq!(call.msg_type, "rpc_call");
        assert_eq!(call.function_name, "list_users");
        assert_eq!(call.params["limit"], 50);
        assert_eq!(call.request_id, "req_test_001");
    }

    #[test]
    fn test_deserialize_messagepack_rpc_call() {
        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "get_user".to_string(),
            params: json!({"id": "user_123"}),
            request_id: "req_msgpack_001".to_string(),
        };

        // Serialize to MessagePack
        let msgpack_bytes = rmp_serde::to_vec_named(&call).unwrap();

        // Deserialize back
        let decoded = deserialize_rpc_message(&msgpack_bytes).unwrap();

        assert_eq!(decoded.function_name, "get_user");
        assert_eq!(decoded.params["id"], "user_123");
        assert_eq!(decoded.request_id, "req_msgpack_001");
    }

    #[test]
    fn test_auto_detect_encoding() {
        // JSON starts with '{'
        let json_call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "test".to_string(),
            params: json!({}),
            request_id: "req_001".to_string(),
        };
        let json_bytes = serde_json::to_vec(&json_call).unwrap();
        assert_eq!(json_bytes[0], b'{');

        let decoded_json = deserialize_rpc_message(&json_bytes).unwrap();
        assert_eq!(decoded_json.function_name, "test");

        // MessagePack starts with binary format marker
        let msgpack_bytes = rmp_serde::to_vec_named(&json_call).unwrap();
        assert!(msgpack_bytes[0] != b'{'); // Not JSON

        let decoded_msgpack = deserialize_rpc_message(&msgpack_bytes).unwrap();
        assert_eq!(decoded_msgpack.function_name, "test");
    }

    #[test]
    fn test_empty_message_error() {
        let result = deserialize_rpc_message(&[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Empty RPC message"));
    }

    // ============================================================================
    // Dispatch Function Tests
    // ============================================================================

    #[test]
    fn test_dispatch_success_simple() {
        let dispatch: RpcDispatchFn = Arc::new(|func, _params| {
            if func == "ping" {
                Ok(json!({"pong": true}))
            } else {
                Err("Unknown function".to_string())
            }
        });

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "ping".to_string(),
            params: json!({}),
            request_id: "req_ping_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.msg_type, "rpc_response");
                assert_eq!(resp.request_id, "req_ping_001");
                assert_eq!(resp.result["pong"], true);
            }
            _ => panic!("Expected successful response"),
        }
    }

    #[test]
    fn test_dispatch_success_with_params() {
        let dispatch: RpcDispatchFn = Arc::new(|func, params| {
            if func == "add" {
                let a = params["a"].as_i64().unwrap_or(0);
                let b = params["b"].as_i64().unwrap_or(0);
                Ok(json!({"result": a + b}))
            } else {
                Err("Unknown function".to_string())
            }
        });

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "add".to_string(),
            params: json!({"a": 10, "b": 32}),
            request_id: "req_add_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["result"], 42);
            }
            _ => panic!("Expected successful response"),
        }
    }

    #[test]
    fn test_dispatch_error_unknown_function() {
        let dispatch: RpcDispatchFn = Arc::new(|func, _params| {
            match func.as_str() {
                "valid_func" => Ok(json!({"ok": true})),
                _ => Err(format!("Unknown RPC method: {}", func)),
            }
        });

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "invalid_func".to_string(),
            params: json!({}),
            request_id: "req_error_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Error(err) => {
                assert_eq!(err.msg_type, "rpc_error");
                assert_eq!(err.request_id, "req_error_001");
                assert!(err.error.contains("Unknown RPC method"));
                assert_eq!(err.error_type, "RpcError");
            }
            _ => panic!("Expected error response"),
        }
    }

    #[test]
    fn test_dispatch_error_invalid_params() {
        let dispatch: RpcDispatchFn = Arc::new(|func, params| {
            if func == "divide" {
                let a = params["a"].as_f64().ok_or("Missing parameter 'a'")?;
                let b = params["b"].as_f64().ok_or("Missing parameter 'b'")?;

                if b == 0.0 {
                    return Err("Division by zero".to_string());
                }

                Ok(json!({"result": a / b}))
            } else {
                Err("Unknown function".to_string())
            }
        });

        // Test missing parameter
        let call1 = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "divide".to_string(),
            params: json!({"a": 10}), // Missing 'b'
            request_id: "req_div_001".to_string(),
        };

        let response1 = dispatch_rpc_call(&call1, &dispatch);
        match response1 {
            RpcMessage::Error(err) => {
                assert!(err.error.contains("Missing parameter"));
            }
            _ => panic!("Expected error for missing parameter"),
        }

        // Test division by zero
        let call2 = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "divide".to_string(),
            params: json!({"a": 10, "b": 0}),
            request_id: "req_div_002".to_string(),
        };

        let response2 = dispatch_rpc_call(&call2, &dispatch);
        match response2 {
            RpcMessage::Error(err) => {
                assert_eq!(err.error, "Division by zero");
            }
            _ => panic!("Expected error for division by zero"),
        }
    }

    #[test]
    fn test_dispatch_multiple_functions() {
        let dispatch: RpcDispatchFn = Arc::new(|func, params| match func.as_str() {
            "get_user" => Ok(json!({"id": params["id"], "name": "John Doe"})),
            "get_benchmarks" => Ok(json!({"latency_ns": 9, "throughput": "1M req/s"})),
            "list_users" => {
                let limit = params["limit"].as_u64().unwrap_or(10);
                Ok(json!({"users": [], "limit": limit}))
            }
            _ => Err(format!("Unknown function: {}", func)),
        });

        // Test get_user
        let call1 = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "get_user".to_string(),
            params: json!({"id": "user_123"}),
            request_id: "req_001".to_string(),
        };

        match dispatch_rpc_call(&call1, &dispatch) {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["name"], "John Doe");
            }
            _ => panic!("Expected response"),
        }

        // Test get_benchmarks
        let call2 = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "get_benchmarks".to_string(),
            params: json!({}),
            request_id: "req_002".to_string(),
        };

        match dispatch_rpc_call(&call2, &dispatch) {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["latency_ns"], 9);
            }
            _ => panic!("Expected response"),
        }

        // Test list_users
        let call3 = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "list_users".to_string(),
            params: json!({"limit": 50}),
            request_id: "req_003".to_string(),
        };

        match dispatch_rpc_call(&call3, &dispatch) {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["limit"], 50);
            }
            _ => panic!("Expected response"),
        }
    }

    // ============================================================================
    // RPC Server Handle Tests
    // ============================================================================

    #[test]
    fn test_rpc_server_handle_creation() {
        let dispatch: RpcDispatchFn = Arc::new(|_func, _params| Ok(json!({"ok": true})));

        let handle = RpcServerHandle::new("/tmp/test-rpc.sock".to_string(), dispatch);

        assert_eq!(handle.socket_path, "/tmp/test-rpc.sock");
    }

    // ============================================================================
    // Edge Case Tests
    // ============================================================================

    #[test]
    fn test_large_payload_serialization() {
        // Test with large data payload (simulate realistic benchmark data)
        let large_data = json!({
            "benchmarks": (0..100).map(|i| json!({
                "name": format!("benchmark_{}", i),
                "duration_ms": i * 10,
                "requests": i * 1000,
                "throughput": (i as f64) * 100.5,
                "metadata": {
                    "timestamp": "2024-01-01T00:00:00Z",
                    "version": "1.0.0",
                    "tags": ["performance", "http", "api"]
                }
            })).collect::<Vec<_>>()
        });

        let response = RpcMessage::Response(RpcResponseMessage {
            msg_type: "rpc_response".to_string(),
            request_id: "req_large_001".to_string(),
            result: large_data,
        });

        let bytes = serialize_rpc_message(&response).unwrap();

        // Should handle large payloads (but still under 100MB limit)
        assert!(bytes.len() < 100 * 1024 * 1024);
        assert!(bytes.len() > 1000); // Should be a substantial size
    }

    #[test]
    fn test_unicode_and_special_characters() {
        let dispatch: RpcDispatchFn = Arc::new(|func, params| {
            if func == "echo" {
                Ok(params)
            } else {
                Err("Unknown function".to_string())
            }
        });

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "echo".to_string(),
            params: json!({
                "text": "Hello 世界 🚀 émojis & spëcial çhars",
                "symbols": "!@#$%^&*()_+-=[]{}|;':\",./<>?"
            }),
            request_id: "req_unicode_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["text"], "Hello 世界 🚀 émojis & spëcial çhars");
                assert!(resp.result["symbols"].as_str().unwrap().contains("@#$%"));
            }
            _ => panic!("Expected successful response with unicode"),
        }
    }

    #[test]
    fn test_nested_json_params() {
        let dispatch: RpcDispatchFn = Arc::new(|func, params| {
            if func == "process_data" {
                let nested_value = &params["data"]["nested"]["value"];
                Ok(json!({"processed": nested_value}))
            } else {
                Err("Unknown function".to_string())
            }
        });

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "process_data".to_string(),
            params: json!({
                "data": {
                    "nested": {
                        "value": 42,
                        "deep": {
                            "deeper": "test"
                        }
                    }
                }
            }),
            request_id: "req_nested_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Response(resp) => {
                assert_eq!(resp.result["processed"], 42);
            }
            _ => panic!("Expected successful response"),
        }
    }

    #[test]
    fn test_null_and_empty_values() {
        let dispatch: RpcDispatchFn = Arc::new(|_func, params| Ok(params));

        let call = RpcCallMessage {
            msg_type: "rpc_call".to_string(),
            function_name: "test_nulls".to_string(),
            params: json!({
                "null_value": null,
                "empty_string": "",
                "empty_array": [],
                "empty_object": {}
            }),
            request_id: "req_null_001".to_string(),
        };

        let response = dispatch_rpc_call(&call, &dispatch);

        match response {
            RpcMessage::Response(resp) => {
                assert!(resp.result["null_value"].is_null());
                assert_eq!(resp.result["empty_string"], "");
                assert_eq!(resp.result["empty_array"].as_array().unwrap().len(), 0);
            }
            _ => panic!("Expected successful response"),
        }
    }
}
