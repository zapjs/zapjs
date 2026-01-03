///! Splice Protocol Worker Runtime
///!
///! This module provides the runtime for user-server binaries to connect to zap-splice
///! and serve exported Rust functions via the Splice protocol.

use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tokio_util::codec::Framed;
use tokio_util::sync::CancellationToken;
use tracing::{info, debug, warn, error};
use bytes::Bytes;
use futures::stream::StreamExt;
use futures::sink::SinkExt;

// Import Splice protocol types from the canonical source
use splice::protocol::{Message, Role, SpliceCodec, ExportMetadata, ErrorKind};

// Import registry for function dispatch and Context wrapper
use crate::registry::build_rpc_dispatcher;
use crate::context::Context;

/// Tracks an in-flight request that can be cancelled
struct InFlightRequest {
    request_id: u64,
    function_name: String,
    cancellation_token: CancellationToken,
    task_handle: JoinHandle<()>,
}

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

    // Build RPC dispatcher from linkme exports
    let dispatcher = Arc::new(build_rpc_dispatcher());
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

    // Split framed stream for concurrent access
    let (write_half, mut read_half) = framed.split();

    // Channel for sending responses from tasks back to write loop
    let (response_tx, mut response_rx) = mpsc::channel::<Message>(256);

    // Track in-flight requests for cancellation
    let in_flight: Arc<RwLock<HashMap<u64, InFlightRequest>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Spawn write loop task to handle all outgoing messages
    let write_task = {
        let mut write_half = write_half;
        tokio::spawn(async move {
            while let Some(msg) = response_rx.recv().await {
                if let Err(e) = write_half.send(msg).await {
                    error!("Failed to send message: {}", e);
                    break;
                }
            }
            debug!("Write loop terminated");
        })
    };

    // Main read loop - processes incoming messages
    loop {
        let msg = match read_half.next().await {
            Some(Ok(msg)) => msg,
            Some(Err(e)) => {
                error!("Protocol error: {}", e);
                break;
            }
            None => {
                info!("Connection closed");
                break;
            }
        };

        match msg {
            Message::ListExports => {
                debug!("Sending exports list ({} functions)", exports.len());
                let _ = response_tx.send(Message::ListExportsResult {
                    exports: exports.clone(),
                }).await;
            }

            Message::Invoke {
                request_id,
                function_name,
                params,
                deadline_ms: _,
                context,
            } => {
                debug!("Invoking function: {} (request_id: {})", function_name, request_id);

                // Create cancellation token for this request
                let cancellation_token = CancellationToken::new();

                // Clone resources for the spawned task
                let dispatcher = dispatcher.clone();
                let response_tx = response_tx.clone();
                let token = cancellation_token.clone();
                let in_flight_clone = in_flight.clone();
                let function_name_for_task = function_name.clone();

                // Spawn task to handle invocation
                let task_handle = tokio::spawn(async move {
                    let start = std::time::Instant::now();

                    // Deserialize params from MessagePack to JSON
                    let params_json: serde_json::Value = rmp_serde::from_slice(&params)
                        .unwrap_or_else(|_| serde_json::json!({}));

                    // Execute function with automatic cancellation via tokio::select!
                    let result = tokio::select! {
                        // Function execution path
                        res = async {
                            dispatcher(function_name_for_task.clone(), params_json, Some(context))
                        } => res,

                        // Cancellation path - triggers when token is cancelled
                        _ = token.cancelled() => {
                            debug!("Function {} cancelled during execution", function_name_for_task);
                            Err("Request cancelled".to_string())
                        }
                    };

                    let duration_us = start.elapsed().as_micros() as u64;

                    // Send result back via channel
                    let response = match result {
                        Ok(result_json) => {
                            // Serialize result to MessagePack
                            match rmp_serde::to_vec(&result_json) {
                                Ok(result_bytes) => Message::InvokeResult {
                                    request_id,
                                    result: Bytes::from(result_bytes),
                                    duration_us,
                                },
                                Err(e) => Message::InvokeError {
                                    request_id,
                                    code: 2000, // ERR_EXECUTION_FAILED
                                    kind: ErrorKind::System,
                                    message: format!("Failed to serialize result: {}", e),
                                    details: None,
                                },
                            }
                        }
                        Err(error_msg) => {
                            // Determine error kind based on cancellation
                            let (code, kind) = if token.is_cancelled() {
                                (2002, ErrorKind::Cancelled) // ERR_CANCELLED
                            } else {
                                (2000, ErrorKind::User) // ERR_EXECUTION_FAILED
                            };

                            Message::InvokeError {
                                request_id,
                                code,
                                kind,
                                message: error_msg,
                                details: None,
                            }
                        }
                    };

                    // Send response and cleanup
                    let _ = response_tx.send(response).await;
                    in_flight_clone.write().await.remove(&request_id);
                    debug!("Request {} completed", request_id);
                });

                // Track in-flight request
                in_flight.write().await.insert(request_id, InFlightRequest {
                    request_id,
                    function_name,
                    cancellation_token,
                    task_handle,
                });
            }

            Message::Cancel { request_id } => {
                debug!("Cancel request: {}", request_id);

                // Trigger cancellation token for this request
                if let Some(req) = in_flight.read().await.get(&request_id) {
                    req.cancellation_token.cancel();
                    debug!("Cancellation token triggered for request {}", request_id);
                } else {
                    debug!("Cancel request for unknown request_id: {}", request_id);
                }

                // Send acknowledgment
                let _ = response_tx.send(Message::CancelAck { request_id }).await;
            }

            Message::Shutdown => {
                info!("Shutdown requested");

                // Cancel all in-flight requests
                {
                    let requests = in_flight.read().await;
                    info!("Cancelling {} in-flight requests", requests.len());
                    for req in requests.values() {
                        req.cancellation_token.cancel();
                    }
                }

                // Wait briefly for tasks to complete
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                // Send shutdown ack
                let _ = response_tx.send(Message::ShutdownAck).await;
                break;
            }

            msg => {
                warn!("Unexpected message: {:?}", msg);
            }
        }
    }

    // Cleanup: drop response_tx to signal write loop to terminate
    drop(response_tx);

    // Wait for write task to finish
    let _ = write_task.await;

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
