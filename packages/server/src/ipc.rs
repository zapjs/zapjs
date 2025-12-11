//! Unix Domain Socket IPC Protocol
//!
//! High-performance inter-process communication between TypeScript wrapper and Rust binary.
//! Protocol: Length-prefixed MessagePack messages (default) with JSON fallback.
//!
//! Frame format: [4-byte big-endian length][payload]
//! - MessagePack: First byte is 0x80-0xBF (map fixmap) or 0xDE-0xDF (map16/32)
//! - JSON: First byte is '{' (0x7B)

use crate::error::{ZapError, ZapResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// IPC encoding format
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum IpcEncoding {
    /// MessagePack (default, ~40% faster)
    #[default]
    MessagePack,
    /// JSON (for debugging)
    Json,
}

/// Messages sent over the IPC channel
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // IpcRequest is used directly, boxing adds overhead
pub enum IpcMessage {
    /// TypeScript asks Rust to invoke a handler
    InvokeHandler {
        handler_id: String,
        request: IpcRequest,
    },

    /// TypeScript responds with handler result
    HandlerResponse {
        handler_id: String,
        status: u16,
        headers: HashMap<String, String>,
        body: String,
    },

    /// Health check ping from TypeScript
    HealthCheck,

    /// Health check response from Rust
    HealthCheckResponse,

    /// Structured error response with full context
    Error {
        /// Machine-readable error code (e.g., "HANDLER_ERROR")
        code: String,
        /// Human-readable error message
        message: String,
        /// HTTP status code
        #[serde(default = "default_error_status")]
        status: u16,
        /// Unique error ID for log correlation
        #[serde(default)]
        digest: String,
        /// Additional error details
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
    },

    // Phase 8: Streaming support
    /// Start a streaming response
    StreamStart {
        stream_id: String,
        status: u16,
        headers: HashMap<String, String>,
    },

    /// A chunk of streaming data
    StreamChunk {
        stream_id: String,
        /// Base64-encoded binary data
        data: String,
    },

    /// End of streaming response
    StreamEnd {
        stream_id: String,
    },

    // Phase 8: WebSocket support
    /// WebSocket connection opened
    WsConnect {
        connection_id: String,
        handler_id: String,
        path: String,
        headers: HashMap<String, String>,
    },

    /// WebSocket message from client
    WsMessage {
        connection_id: String,
        handler_id: String,
        /// Message data (text or base64-encoded binary)
        data: String,
        /// true if binary data
        binary: bool,
    },

    /// WebSocket connection closed
    WsClose {
        connection_id: String,
        handler_id: String,
        code: Option<u16>,
        reason: Option<String>,
    },

    /// WebSocket message to send to client (TypeScript -> Rust)
    WsSend {
        connection_id: String,
        data: String,
        binary: bool,
    },
}

fn default_error_status() -> u16 {
    500
}

/// Serialize an IPC message to bytes
pub fn serialize_message(msg: &IpcMessage, encoding: IpcEncoding) -> ZapResult<Vec<u8>> {
    match encoding {
        IpcEncoding::MessagePack => {
            // IMPORTANT: Use to_vec_named to preserve string field names
            // This is required for #[serde(tag = "type")] to work correctly
            // with @msgpack/msgpack on the TypeScript side
            rmp_serde::to_vec_named(msg).map_err(|e| ZapError::ipc(format!("MessagePack serialize error: {}", e)))
        }
        IpcEncoding::Json => {
            serde_json::to_vec(msg).map_err(|e| ZapError::ipc(format!("JSON serialize error: {}", e)))
        }
    }
}

/// Deserialize an IPC message from bytes, auto-detecting encoding
pub fn deserialize_message(data: &[u8]) -> ZapResult<IpcMessage> {
    if data.is_empty() {
        return Err(ZapError::ipc("Empty message".to_string()));
    }

    // Auto-detect encoding from first byte
    let first_byte = data[0];
    if first_byte == b'{' {
        // JSON
        serde_json::from_slice(data).map_err(|e| ZapError::ipc(format!("JSON deserialize error: {}", e)))
    } else {
        // MessagePack (maps start with 0x80-0xBF, 0xDE, or 0xDF)
        rmp_serde::from_slice(data).map_err(|e| ZapError::ipc(format!("MessagePack deserialize error: {}", e)))
    }
}

/// Request data sent to TypeScript handler
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRequest {
    /// Unique request ID for correlation across Rust/TypeScript boundary
    pub request_id: String,

    /// HTTP method (GET, POST, etc.)
    pub method: String,

    /// Full path with query string
    pub path: String,

    /// Path without query string
    pub path_only: String,

    /// Query parameters
    pub query: HashMap<String, String>,

    /// Route parameters (from :id in path)
    pub params: HashMap<String, String>,

    /// HTTP headers
    pub headers: HashMap<String, String>,

    /// Request body as UTF-8 string
    pub body: String,

    /// Cookies parsed from headers
    pub cookies: HashMap<String, String>,
}

/// IPC Server - receives requests from Rust, forwards to TypeScript
pub struct IpcServer {
    socket_path: String,
}

impl IpcServer {
    /// Create a new IPC server
    pub fn new(socket_path: String) -> Self {
        Self { socket_path }
    }

    /// Start listening on the Unix socket
    pub async fn listen(&self) -> ZapResult<()> {
        // Remove existing socket file if it exists
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.socket_path);
        }

        // Create Unix socket listener
        let listener = tokio::net::UnixListener::bind(&self.socket_path)
            .map_err(|e| ZapError::ipc(format!("Failed to bind socket: {}", e)))?;

        tracing::info!("🔌 IPC server listening on {}", self.socket_path);

        // Accept connections in background
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        tokio::spawn(async move {
                            if let Err(e) = handle_ipc_connection(stream).await {
                                tracing::error!("IPC connection error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        tracing::error!("IPC accept error: {}", e);
                    }
                }
            }
        });

        Ok(())
    }
}

/// IPC Client - connects to TypeScript's IPC server
pub struct IpcClient {
    stream: UnixStream,
    encoding: IpcEncoding,
}

impl IpcClient {
    /// Connect to a remote IPC server with default MessagePack encoding
    pub async fn connect(socket_path: &str) -> ZapResult<Self> {
        Self::connect_with_encoding(socket_path, IpcEncoding::default()).await
    }

    /// Connect to a remote IPC server with specified encoding
    pub async fn connect_with_encoding(socket_path: &str, encoding: IpcEncoding) -> ZapResult<Self> {
        let stream = UnixStream::connect(socket_path).await.map_err(|e| {
            ZapError::ipc(format!("Failed to connect to IPC socket: {}", e))
        })?;

        Ok(Self { stream, encoding })
    }

    /// Send a message over the IPC channel using length-prefixed framing
    pub async fn send_message(&mut self, msg: IpcMessage) -> ZapResult<()> {
        let payload = serialize_message(&msg, self.encoding)?;
        let len = payload.len() as u32;

        // ATOMIC: Combine length prefix and payload into single buffer to prevent frame corruption
        let mut frame = Vec::with_capacity(4 + payload.len());
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(&payload);

        // Single atomic write
        self.stream
            .write_all(&frame)
            .await
            .map_err(|e| ZapError::ipc(format!("Write frame error: {}", e)))?;

        self.stream.flush().await.map_err(|e| {
            ZapError::ipc(format!("Flush error: {}", e))
        })?;

        Ok(())
    }

    /// Receive a message from the IPC channel using length-prefixed framing
    pub async fn recv_message(&mut self) -> ZapResult<Option<IpcMessage>> {
        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        match self.stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(ZapError::ipc(format!("Read length error: {}", e))),
        }

        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 100 * 1024 * 1024 {
            // 100MB limit
            return Err(ZapError::ipc(format!("Message too large: {} bytes", len)));
        }

        // Read payload
        let mut buffer = vec![0u8; len];
        self.stream
            .read_exact(&mut buffer)
            .await
            .map_err(|e| ZapError::ipc(format!("Read payload error: {}", e)))?;

        // Auto-detect encoding and deserialize
        let msg = deserialize_message(&buffer)?;

        Ok(Some(msg))
    }

    /// Send a message and receive a response (request-response pattern)
    pub async fn send_recv(&mut self, msg: IpcMessage) -> ZapResult<IpcMessage> {
        self.send_message(msg).await?;
        match self.recv_message().await? {
            Some(response) => Ok(response),
            None => Err(ZapError::ipc("Connection closed".to_string())),
        }
    }

    /// Get the encoding being used
    pub fn encoding(&self) -> IpcEncoding {
        self.encoding
    }
}

/// Handle an IPC client connection (for future use)
async fn handle_ipc_connection(mut _stream: UnixStream) -> ZapResult<()> {
    // Currently, the Rust server only initiates connections to TypeScript
    // This handler is here for future bidirectional communication
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ipc_message_json_serialization() {
        let msg = IpcMessage::HealthCheck;
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("health_check"));

        let decoded: IpcMessage = serde_json::from_str(&json).unwrap();
        matches!(decoded, IpcMessage::HealthCheck);
    }

    #[test]
    fn test_ipc_message_msgpack_serialization() {
        let msg = IpcMessage::HealthCheck;
        let msgpack = serialize_message(&msg, IpcEncoding::MessagePack).unwrap();
        let decoded = deserialize_message(&msgpack).unwrap();
        matches!(decoded, IpcMessage::HealthCheck);
    }

    #[test]
    fn test_ipc_request_json_serialization() {
        let req = IpcRequest {
            request_id: "test-request-123".to_string(),
            method: "GET".to_string(),
            path: "/api/users/123?sort=asc".to_string(),
            path_only: "/api/users/123".to_string(),
            query: {
                let mut m = HashMap::new();
                m.insert("sort".to_string(), "asc".to_string());
                m
            },
            params: {
                let mut m = HashMap::new();
                m.insert("id".to_string(), "123".to_string());
                m
            },
            headers: HashMap::new(),
            body: String::new(),
            cookies: HashMap::new(),
        };

        let json = serde_json::to_string(&req).unwrap();
        let decoded: IpcRequest = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded.method, "GET");
        assert_eq!(decoded.path, "/api/users/123?sort=asc");
        assert_eq!(decoded.params.get("id").unwrap(), "123");
    }

    #[test]
    fn test_ipc_request_msgpack_serialization() {
        let req = IpcRequest {
            request_id: "test-request-123".to_string(),
            method: "GET".to_string(),
            path: "/api/users/123".to_string(),
            path_only: "/api/users/123".to_string(),
            query: HashMap::new(),
            params: {
                let mut m = HashMap::new();
                m.insert("id".to_string(), "123".to_string());
                m
            },
            headers: HashMap::new(),
            body: String::new(),
            cookies: HashMap::new(),
        };

        let msg = IpcMessage::InvokeHandler {
            handler_id: "handler_0".to_string(),
            request: req,
        };

        let msgpack = serialize_message(&msg, IpcEncoding::MessagePack).unwrap();
        let json = serialize_message(&msg, IpcEncoding::Json).unwrap();

        // MessagePack should be smaller
        assert!(msgpack.len() < json.len(), "MessagePack ({}) should be smaller than JSON ({})", msgpack.len(), json.len());

        // Both should deserialize correctly
        let decoded_msgpack = deserialize_message(&msgpack).unwrap();
        let decoded_json = deserialize_message(&json).unwrap();

        if let (
            IpcMessage::InvokeHandler { request: req1, .. },
            IpcMessage::InvokeHandler { request: req2, .. },
        ) = (decoded_msgpack, decoded_json)
        {
            assert_eq!(req1.method, req2.method);
            assert_eq!(req1.path, req2.path);
        } else {
            panic!("Unexpected message types");
        }
    }

    #[test]
    fn test_auto_detect_encoding() {
        let msg = IpcMessage::HealthCheck;

        // JSON starts with '{'
        let json = serialize_message(&msg, IpcEncoding::Json).unwrap();
        assert_eq!(json[0], b'{');
        let decoded_json = deserialize_message(&json).unwrap();
        matches!(decoded_json, IpcMessage::HealthCheck);

        // MessagePack starts with 0x80-0xBF for fixmap
        let msgpack = serialize_message(&msg, IpcEncoding::MessagePack).unwrap();
        assert!(msgpack[0] >= 0x80 || msgpack[0] == 0xDE || msgpack[0] == 0xDF);
        let decoded_msgpack = deserialize_message(&msgpack).unwrap();
        matches!(decoded_msgpack, IpcMessage::HealthCheck);
    }

    #[test]
    fn test_stream_messages() {
        let start = IpcMessage::StreamStart {
            stream_id: "stream-123".to_string(),
            status: 200,
            headers: HashMap::new(),
        };

        let chunk = IpcMessage::StreamChunk {
            stream_id: "stream-123".to_string(),
            data: "SGVsbG8gV29ybGQ=".to_string(), // "Hello World" base64
        };

        let end = IpcMessage::StreamEnd {
            stream_id: "stream-123".to_string(),
        };

        // Test serialization round-trip
        for msg in [start, chunk, end] {
            let msgpack = serialize_message(&msg, IpcEncoding::MessagePack).unwrap();
            let _decoded = deserialize_message(&msgpack).unwrap();
        }
    }

    #[test]
    fn test_websocket_messages() {
        let connect = IpcMessage::WsConnect {
            connection_id: "ws-123".to_string(),
            handler_id: "ws_handler_0".to_string(),
            path: "/ws/chat".to_string(),
            headers: HashMap::new(),
        };

        let message = IpcMessage::WsMessage {
            connection_id: "ws-123".to_string(),
            handler_id: "ws_handler_0".to_string(),
            data: "Hello".to_string(),
            binary: false,
        };

        let close = IpcMessage::WsClose {
            connection_id: "ws-123".to_string(),
            handler_id: "ws_handler_0".to_string(),
            code: Some(1000),
            reason: Some("Normal closure".to_string()),
        };

        // Test serialization round-trip
        for msg in [connect, message, close] {
            let msgpack = serialize_message(&msg, IpcEncoding::MessagePack).unwrap();
            let _decoded = deserialize_message(&msgpack).unwrap();
        }
    }
}
