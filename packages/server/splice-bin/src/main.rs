use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use splice::{
    protocol::{Message, Role, SpliceCodec, PROTOCOL_VERSION, CAP_STREAMING, CAP_CANCELLATION, DEFAULT_MAX_FRAME_SIZE},
    supervisor::{Supervisor, SupervisorConfig, WorkerState},
    router::{Router, RouterConfig},
    reload::ReloadManager,
    metrics::Metrics,
};
use tokio_util::codec::Framed;
use futures::stream::StreamExt;
use futures::sink::SinkExt;

#[derive(Parser)]
#[command(name = "splice")]
#[command(about = "Splice Protocol Runtime", long_about = None)]
struct Cli {
    #[arg(long, help = "Unix socket path for host connection")]
    socket: PathBuf,

    #[arg(long, help = "Path to worker binary")]
    worker: PathBuf,

    #[arg(long, help = "Watch paths for hot reload (comma-separated)")]
    watch: Option<String>,

    #[arg(long, help = "Maximum concurrent requests", default_value = "1024")]
    max_concurrency: usize,

    #[arg(long, help = "Default timeout in seconds", default_value = "30")]
    timeout: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();

    let cli = Cli::parse();

    info!("Starting Splice runtime");
    info!("Socket: {}", cli.socket.display());
    info!("Worker: {}", cli.worker.display());

    // Create runtime components
    let supervisor_config = SupervisorConfig::default();
    let router_config = RouterConfig {
        max_concurrent_requests: cli.max_concurrency,
        max_concurrent_per_function: 256, // Increased to handle test load
        default_timeout: Duration::from_secs(cli.timeout),
    };

    let worker_socket = cli.socket.parent()
        .unwrap_or(&cli.socket)
        .join("worker.sock");

    let mut supervisor = Supervisor::new(
        supervisor_config,
        cli.worker.clone(),
        worker_socket.clone(),
    );

    // Create router and wire up worker channel BEFORE wrapping in Arc
    let mut router = Router::new(router_config);
    let (supervisor_tx, mut supervisor_rx) = mpsc::channel::<Message>(100);
    router.set_worker_tx(supervisor_tx);
    let router = Arc::new(router);
    let metrics = Metrics::new();
    let mut reload_manager = ReloadManager::new(cli.worker.clone());

    // Create worker listener socket BEFORE starting worker
    if worker_socket.exists() {
        tokio::fs::remove_file(&worker_socket).await?;
    }
    let worker_listener = UnixListener::bind(&worker_socket)?;
    info!("Worker socket listening on: {}", worker_socket.display());

    // Start accepting connections in background
    let accept_handle = tokio::spawn(async move {
        worker_listener.accept().await
    });

    // Start worker
    match supervisor.start().await {
        Ok(info) => {
            info!("Worker started: PID {}", info.pid);
        }
        Err(e) => {
            error!("Failed to start worker: {}", e);
            return Err(e.into());
        }
    }

    // Wait for worker connection
    let (worker_stream, _) = accept_handle.await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))??;
    let mut worker_framed = Framed::new(worker_stream, SpliceCodec::default());

    // Worker handshake
    if let Some(Ok(Message::Handshake { protocol_version, role, capabilities, .. })) = worker_framed.next().await {
        if protocol_version != PROTOCOL_VERSION {
            error!("Protocol version mismatch");
            return Ok(());
        }
        if role != Role::Worker {
            error!("Expected Worker role");
            return Ok(());
        }

        let server_id = uuid::Uuid::new_v4().as_bytes().clone();
        worker_framed.send(Message::HandshakeAck {
            protocol_version: PROTOCOL_VERSION,
            capabilities: capabilities & (CAP_STREAMING | CAP_CANCELLATION),
            server_id,
            export_count: 0,
        }).await?;

        supervisor.update_state(WorkerState::Ready);
        info!("Worker handshake complete");
    } else {
        error!("Invalid worker handshake");
        return Ok(());
    }

    // Request exports from worker
    worker_framed.send(Message::ListExports).await?;
    if let Some(Ok(Message::ListExportsResult { exports })) = worker_framed.next().await {
        info!("Received {} exports from worker", exports.len());
        router.update_exports(exports).await;
    }

    // Split worker_framed into separate read/write halves
    let (mut worker_write, mut worker_read) = worker_framed.split();

    // Task 1: Supervisor→Worker bridge (mpsc → worker socket)
    tokio::spawn(async move {
        while let Some(msg) = supervisor_rx.recv().await {
            if let Err(e) = worker_write.send(msg).await {
                error!("Failed to send message to worker: {}", e);
                break;
            }
        }
        warn!("Supervisor→Worker bridge terminated");
    });

    // Task 2: Worker→Supervisor bridge (worker socket → Router)
    let router_for_worker = Arc::clone(&router);
    tokio::spawn(async move {
        while let Some(result) = worker_read.next().await {
            match result {
                Ok(msg) => {
                    router_for_worker.handle_worker_message(msg).await;
                }
                Err(e) => {
                    error!("Worker frame decode error: {}", e);
                    break;
                }
            }
        }
        warn!("Worker→Supervisor bridge terminated");
    });

    // Create host listener socket
    if cli.socket.exists() {
        tokio::fs::remove_file(&cli.socket).await?;
    }
    let host_listener = UnixListener::bind(&cli.socket)?;
    info!("Host socket listening on: {}", cli.socket.display());

    // Main loop - accept host connections
    loop {
        tokio::select! {
            // Accept host connection
            accept_result = host_listener.accept() => {
                match accept_result {
                    Ok((host_stream, _)) => {
                        info!("Host connected");
                        let mut host_framed = Framed::new(host_stream, SpliceCodec::default());

                        // Host handshake
                        if let Some(Ok(Message::Handshake { protocol_version, role, capabilities, .. })) = host_framed.next().await {
                            if protocol_version == PROTOCOL_VERSION && role == Role::Host {
                                let server_id = uuid::Uuid::new_v4().as_bytes().clone();
                                let exports = router.get_exports().await;
                                let _ = host_framed.send(Message::HandshakeAck {
                                    protocol_version: PROTOCOL_VERSION,
                                    capabilities: capabilities & (CAP_STREAMING | CAP_CANCELLATION),
                                    server_id,
                                    export_count: exports.len() as u32,
                                }).await;

                                info!("Host handshake complete");

                                // Handle host connection in separate task
                                let exports_for_task = exports.clone();
                                let router_for_task = Arc::clone(&router);
                                tokio::spawn(async move {
                                    while let Some(Ok(msg)) = host_framed.next().await {
                                        match msg {
                                            Message::ListExports => {
                                                info!("Host requested exports list");
                                                let _ = host_framed.send(Message::ListExportsResult {
                                                    exports: exports_for_task.clone(),
                                                }).await;
                                            }
                                            Message::Invoke { request_id, function_name, params, deadline_ms, context } => {
                                                info!("Host invoked: {}", function_name);
                                                match router_for_task.invoke(
                                                    function_name.clone(),
                                                    params.clone(),
                                                    deadline_ms,
                                                    context,
                                                ).await {
                                                    Ok(result) => {
                                                        let _ = host_framed.send(Message::InvokeResult {
                                                            request_id,
                                                            result,
                                                            duration_us: 0,
                                                        }).await;
                                                    }
                                                    Err(e) => {
                                                        let (code, kind, message) = match e {
                                                            splice::router::RouterError::Timeout => (splice::protocol::ERR_TIMEOUT, splice::protocol::ErrorKind::System, "Request timeout".to_string()),
                                                            splice::router::RouterError::Overloaded => (splice::protocol::ERR_OVERLOADED, splice::protocol::ErrorKind::System, "System overloaded".to_string()),
                                                            splice::router::RouterError::Cancelled => (splice::protocol::ERR_CANCELLED, splice::protocol::ErrorKind::System, "Request cancelled".to_string()),
                                                            splice::router::RouterError::WorkerUnavailable => (2004, splice::protocol::ErrorKind::System, "Worker not available".to_string()),
                                                            splice::router::RouterError::ExecutionError(msg) => (2000, splice::protocol::ErrorKind::User, msg),
                                                        };
                                                        let _ = host_framed.send(Message::InvokeError {
                                                            request_id,
                                                            code,
                                                            kind,
                                                            message,
                                                            details: None,
                                                        }).await;
                                                    }
                                                }
                                            }
                                            Message::Shutdown => {
                                                let _ = host_framed.send(Message::ShutdownAck).await;
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                });
                            }
                        }
                    }
                    Err(e) => {
                        error!("Error accepting host connection: {}", e);
                    }
                }
            }

            // Health check interval
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if !supervisor.is_ready() {
                    warn!("Worker not ready, attempting restart");
                    if let Err(e) = supervisor.restart().await {
                        error!("Failed to restart worker: {}", e);
                    }
                }
            }

            // Hot reload check
            _ = tokio::time::sleep(Duration::from_secs(1)), if cli.watch.is_some() => {
                if let Ok(true) = reload_manager.check_for_changes().await {
                    info!("Initiating hot reload");
                    if let Err(e) = reload_manager.perform_reload(&mut supervisor, Duration::from_secs(30)).await {
                        error!("Hot reload failed: {}", e);
                    }
                }
            }
        }
    }
}
