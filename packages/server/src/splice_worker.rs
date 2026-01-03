///! Splice Protocol Worker Runtime
///!
///! This module provides the runtime for user-server binaries to connect to zap-splice
///! and serve exported Rust functions via the Splice protocol.

use std::env;
use tokio::net::UnixStream;
use tokio_util::codec::Framed;
use tracing::{info, debug, warn};
use bytes::Bytes;
use futures::stream::StreamExt;
use futures::sink::SinkExt;

// Import Splice protocol types from the canonical source
use splice::protocol::{Message, Role, SpliceCodec, ExportMetadata, RequestContext, AuthContext, ErrorKind};

// Import registry for function dispatch
use crate::registry::build_rpc_dispatcher;

/// Run the Splice worker runtime
///
/// This function should be called from the user-server's main function:
/// ```ignore
/// #[tokio::main]
/// async fn main() {
///     zap_server::splice_worker::run().await.unwrap();
/// }
/// ```
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    info!("Starting Splice worker runtime");

    // Get socket path from environment
    let socket_path = env::var("ZAP_SOCKET")
        .map_err(|_| "ZAP_SOCKET environment variable not set")?;

    info!("Connecting to zap-splice at: {}", socket_path);

    // Connect to zap-splice
    let stream = UnixStream::connect(&socket_path).await?;
    let mut framed = create_framed_stream(stream);

    // Build RPC dispatcher from inventory
    let dispatcher = build_rpc_dispatcher();
    let exports = collect_exports();

    // Send handshake
    send_message(&mut framed, Message::Handshake {
        protocol_version: 0x00010000,
        role: Role::Worker,
        capabilities: 0b11, // Streaming + Cancellation
        max_frame_size: 100 * 1024 * 1024,
    }).await?;

    // Wait for handshake ack
    match receive_message(&mut framed).await? {
        Message::HandshakeAck { .. } => {
            info!("Handshake complete");
        }
        _ => {
            return Err("Expected HandshakeAck".into());
        }
    }

    // Message loop
    loop {
        match receive_message(&mut framed).await? {
            Message::ListExports => {
                debug!("Sending exports list ({} functions)", exports.len());
                send_message(&mut framed, Message::ListExportsResult {
                    exports: exports.clone(),
                }).await?;
            }

            Message::Invoke {
                request_id,
                function_name,
                params,
                deadline_ms,
                context,
            } => {
                debug!("Invoking function: {} (request_id: {})", function_name, request_id);

                let start = std::time::Instant::now();

                // Deserialize params from MessagePack to JSON
                let params_json: serde_json::Value = rmp_serde::from_slice(&params)
                    .unwrap_or_else(|_| serde_json::json!({}));

                // Call function via dispatcher with context
                let result = dispatcher(function_name.clone(), params_json, Some(context));

                let duration_us = start.elapsed().as_micros() as u64;

                match result {
                    Ok(result_json) => {
                        // Serialize result to MessagePack
                        let result_bytes = rmp_serde::to_vec(&result_json)
                            .map_err(|e| format!("Failed to serialize result: {}", e))?;

                        send_message(&mut framed, Message::InvokeResult {
                            request_id,
                            result: Bytes::from(result_bytes),
                            duration_us,
                        }).await?;
                    }
                    Err(error_msg) => {
                        send_message(&mut framed, Message::InvokeError {
                            request_id,
                            code: 2000, // ERR_EXECUTION_FAILED
                            kind: ErrorKind::User,
                            message: error_msg,
                            details: None,
                        }).await?;
                    }
                }
            }

            Message::Cancel { request_id } => {
                debug!("Cancel request: {}", request_id);
                // TODO: Implement cancellation support
                send_message(&mut framed, Message::CancelAck { request_id }).await?;
            }

            Message::Shutdown => {
                info!("Shutdown requested");
                send_message(&mut framed, Message::ShutdownAck).await?;
                break;
            }

            msg => {
                warn!("Unexpected message: {:?}", msg);
            }
        }
    }

    info!("Worker runtime shutting down");
    Ok(())
}

/// Collect exported functions from linkme distributed slice
fn collect_exports() -> Vec<ExportMetadata> {
    use crate::registry::EXPORTS;

    EXPORTS
        .iter()
        .map(|f| ExportMetadata {
            name: f.name.to_string(),
            is_async: f.is_async,
            is_streaming: false, // TODO: Support streaming
            params_schema: "{}".to_string(), // TODO: Extract from function
            return_schema: "{}".to_string(), // TODO: Extract from function
        })
        .collect()
}

// Create framed stream using Splice protocol codec
fn create_framed_stream(stream: UnixStream) -> Framed<UnixStream, SpliceCodec> {
    Framed::new(stream, SpliceCodec::default())
}

async fn send_message(
    framed: &mut Framed<UnixStream, SpliceCodec>,
    msg: Message,
) -> Result<(), Box<dyn std::error::Error>> {
    framed.send(msg).await?;
    Ok(())
}

async fn receive_message(
    framed: &mut Framed<UnixStream, SpliceCodec>,
) -> Result<Message, Box<dyn std::error::Error>> {
    framed
        .next()
        .await
        .ok_or("Connection closed")?
        .map_err(Into::into)
}