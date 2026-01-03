///! Splice Protocol Client
///!
///! This module provides the client for the main zap binary to connect to Splice
///! and invoke user Rust functions via the Splice protocol.

use bytes::Bytes;
use std::sync::Arc;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{error, info, warn};
use std::collections::HashMap;

// Import Splice protocol types from canonical source
use splice::protocol::{Message, ExportMetadata, RequestContext, Role, SpliceCodec};

pub struct SpliceClient {
    tx: mpsc::Sender<ClientRequest>,
    exports: Arc<tokio::sync::RwLock<Vec<ExportMetadata>>>,
}

enum ClientRequest {
    Invoke {
        function_name: String,
        params: serde_json::Value,
        response_tx: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    Shutdown,
}

impl SpliceClient {
    /// Connect to Splice supervisor
    pub async fn connect(socket_path: String) -> Result<Self, Box<dyn std::error::Error>> {
        info!("Connecting to Splice at: {}", socket_path);

        let stream = UnixStream::connect(&socket_path).await?;

        // Send handshake
        Self::send_raw_message(&stream, Message::Handshake {
            protocol_version: 0x00010000,
            role: Role::Host,
            capabilities: 0b11, // Streaming + Cancellation
            max_frame_size: 100 * 1024 * 1024,
        }).await?;

        // Wait for handshake ack
        match Self::receive_raw_message(&stream).await? {
            Message::HandshakeAck { export_count, .. } => {
                info!("Handshake complete, {} exports available", export_count);
            }
            _ => {
                return Err("Expected HandshakeAck".into());
            }
        }

        // Request exports
        Self::send_raw_message(&stream, Message::ListExports).await?;

        let exports = match Self::receive_raw_message(&stream).await? {
            Message::ListExportsResult { exports } => {
                info!("Received {} exports", exports.len());
                Arc::new(tokio::sync::RwLock::new(exports))
            }
            _ => {
                return Err("Expected ListExportsResult".into());
            }
        };

        // Create message channel
        let (tx, rx) = mpsc::channel(100);

        // Spawn protocol handler
        let exports_clone = exports.clone();
        tokio::spawn(async move {
            if let Err(e) = Self::run_protocol_loop(stream, rx).await {
                error!("Splice protocol loop error: {}", e);
            }
        });

        Ok(Self { tx, exports })
    }

    /// Invoke a Rust function
    pub async fn invoke(
        &self,
        function_name: String,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let (response_tx, response_rx) = oneshot::channel();

        self.tx
            .send(ClientRequest::Invoke {
                function_name,
                params,
                response_tx,
            })
            .await
            .map_err(|e| format!("Failed to send request: {}", e))?;

        response_rx
            .await
            .map_err(|e| format!("Failed to receive response: {}", e))?
    }

    /// Get list of available exports
    pub async fn exports(&self) -> Vec<ExportMetadata> {
        self.exports.read().await.clone()
    }

    /// Shutdown the client
    pub async fn shutdown(&self) -> Result<(), String> {
        self.tx
            .send(ClientRequest::Shutdown)
            .await
            .map_err(|e| format!("Failed to send shutdown: {}", e))
    }

    async fn run_protocol_loop(
        stream: UnixStream,
        mut rx: mpsc::Receiver<ClientRequest>,
    ) -> Result<(), String> {
        use futures::stream::StreamExt;
        use futures::sink::SinkExt;
        use tokio_util::codec::Framed;

        let mut framed = Framed::new(stream, SpliceCodec::default());
        let mut pending_requests: HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>> =
            HashMap::new();
        let mut next_request_id = 1u64;

        loop {
            tokio::select! {
                // Handle client requests
                Some(req) = rx.recv() => {
                    match req {
                        ClientRequest::Invoke {
                            function_name,
                            params,
                            response_tx,
                        } => {
                            let request_id = next_request_id;
                            next_request_id = next_request_id.wrapping_add(1);

                            // Serialize params to MessagePack
                            let params_bytes = rmp_serde::to_vec(&params)
                                .map_err(|e| format!("Failed to serialize params: {}", e))?;

                            // Send invoke message
                            let msg = Message::Invoke {
                                request_id,
                                function_name,
                                params: Bytes::from(params_bytes),
                                deadline_ms: 30000, // 30 second timeout
                                context: RequestContext {
                                    trace_id: 0,
                                    span_id: 0,
                                    headers: vec![],
                                    auth: None,
                                },
                            };

                            framed.send(msg).await.map_err(|e| e.to_string())?;
                            pending_requests.insert(request_id, response_tx);
                        }
                        ClientRequest::Shutdown => {
                            framed.send(Message::Shutdown).await.map_err(|e| e.to_string())?;
                            break;
                        }
                    }
                }

                // Handle splice messages
                result = framed.next() => {
                    match result {
                        Some(Ok(Message::InvokeResult { request_id, result, .. })) => {
                            if let Some(response_tx) = pending_requests.remove(&request_id) {
                                let result_json: serde_json::Value = rmp_serde::from_slice(&result)
                                    .unwrap_or_else(|_| serde_json::json!(null));
                                let _ = response_tx.send(Ok(result_json));
                            }
                        }
                        Some(Ok(Message::InvokeError { request_id, message, .. })) => {
                            if let Some(response_tx) = pending_requests.remove(&request_id) {
                                let _ = response_tx.send(Err(message));
                            }
                        }
                        Some(Ok(Message::ShutdownAck)) => {
                            info!("Splice client shutdown acknowledged");
                            break;
                        }
                        Some(Ok(msg)) => {
                            warn!("Unexpected message: {:?}", msg);
                        }
                        Some(Err(e)) => {
                            return Err(format!("Protocol error: {}", e));
                        }
                        None => {
                            return Err("Connection closed".to_string());
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn send_raw_message(
        stream: &UnixStream,
        msg: Message,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use tokio_util::codec::Encoder;
        use bytes::BytesMut;

        let mut codec = SpliceCodec::default();
        let mut buf = BytesMut::new();
        codec.encode(msg, &mut buf)?;

        stream.writable().await?;
        stream.try_write(&buf)?;
        Ok(())
    }

    async fn receive_raw_message(
        stream: &UnixStream,
    ) -> Result<Message, Box<dyn std::error::Error>> {
        use tokio_util::codec::Decoder;
        use bytes::BytesMut;

        let mut codec = SpliceCodec::default();
        let mut buf = BytesMut::with_capacity(4096);

        loop {
            stream.readable().await?;

            match stream.try_read_buf(&mut buf) {
                Ok(0) => return Err("Connection closed".into()),
                Ok(_) => {
                    if let Some(msg) = codec.decode(&mut buf)? {
                        return Ok(msg);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    continue;
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}
