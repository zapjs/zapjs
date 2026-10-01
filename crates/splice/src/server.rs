use crate::{
    wire::{self, Message},
    Config, Error, ErrorKind, RemoteError,
};
use bytes::Bytes;
use futures_util::{SinkExt, Stream, StreamExt};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{net::UnixStream, sync::mpsc, task::JoinSet};
use tokio_util::sync::CancellationToken;

struct ConnectionGuard(CancellationToken);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub struct Invocation {
    pub function: String,
    pub payload: Bytes,
    pub cancellation: CancellationToken,
}

pub struct StreamInvocation {
    pub function: String,
    pub payload: Bytes,
    pub cancellation: CancellationToken,
}

/// Serve one trusted, already-connected Rust peer. The caller owns socket creation,
/// subprocess supervision, authentication/permissions, and worker replacement.
/// A disconnected peer cancels every handler; requests are never implicitly retried.
pub async fn serve<H, F>(stream: UnixStream, config: Config, handler: H) -> Result<(), Error>
where
    H: Fn(Invocation) -> F + Send + Sync + 'static,
    F: Future<Output = Result<Bytes, RemoteError>> + Send + 'static,
{
    let (socket, frame_limit) = wire::handshake(stream, &config, true).await?;
    let (mut writer, mut reader) = socket.split();
    let closed = CancellationToken::new();
    let _guard = ConnectionGuard(closed.clone());
    let (outgoing, mut queue) = mpsc::channel::<Bytes>(config.max_in_flight);
    let writer_closed = closed.clone();
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = writer_closed.cancelled() => break,
                frame = queue.recv() => {
                    let Some(frame) = frame else { break };
                    let result = tokio::select! {
                        biased;
                        _ = writer_closed.cancelled() => break,
                        result = writer.send(frame) => result,
                    };
                    if result.is_err() { writer_closed.cancel(); break; }
                }
            }
        }
    });
    let handler = Arc::new(handler);
    let mut tasks = JoinSet::new();
    let mut active: HashMap<u64, CancellationToken> = HashMap::new();
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = closed.cancelled() => return Err(Error::Disconnected),
                result = tasks.join_next(), if !tasks.is_empty() => {
                    let Some(result) = result else {
                        return Err(Error::Protocol("worker task set ended unexpectedly".into()));
                    };
                    let (id, result) = result
                        .map_err(|e| Error::Protocol(format!("worker handler failed: {e}")))?;
                    active.remove(&id);
                    result?;
                }
                frame = reader.next() => {
                    let Some(frame) = frame else { return Ok(()) };
                    match wire::decode(&frame.map_err(Error::io)?)? {
                        Message::Invoke { id, function, payload, timeout_ms } => {
                            if id == 0 || active.contains_key(&id) || timeout_ms == 0 {
                                return Err(Error::Protocol("invalid or duplicate request ID/deadline".into()));
                            }
                            if active.len() >= config.max_in_flight {
                                let reply = Message::Result { id, result: Err(RemoteError::new(ErrorKind::Overloaded, "worker capacity exhausted")) };
                                outgoing.try_send(wire::encode(&reply, frame_limit)?)
                                    .map_err(|_| Error::Overloaded)?;
                                continue;
                            }
                            let cancellation = closed.child_token();
                            active.insert(id, cancellation.clone());
                            let timeout = Duration::from_millis(timeout_ms).min(config.max_request_timeout);
                            let handler = handler.clone();
                            let outgoing = outgoing.clone();
                            let task_closed = closed.clone();
                            tasks.spawn(async move {
                                let invocation = Invocation { function, payload, cancellation: cancellation.clone() };
                                let work = handler(invocation);
                                tokio::pin!(work);
                                let deadline = tokio::time::sleep(timeout);
                                tokio::pin!(deadline);
                                let result = tokio::select! {
                                    biased;
                                    _ = cancellation.cancelled() => Err(RemoteError::new(ErrorKind::Cancelled, "request cancelled")),
                                    _ = &mut deadline => {
                                        cancellation.cancel();
                                        Err(RemoteError::new(ErrorKind::Deadline, "worker deadline exceeded"))
                                    }
                                    result = &mut work => result,
                                };
                                let encoded = wire::encode(&Message::Result { id, result }, frame_limit);
                                let result = match encoded {
                                    Ok(frame) => tokio::select! {
                                        biased;
                                        _ = task_closed.cancelled() => Err(Error::Disconnected),
                                        result = outgoing.send(frame) => result.map_err(|_| Error::Disconnected),
                                    },
                                    Err(error) => Err(error),
                                };
                                (id, result)
                            });
                        }
                        Message::Cancel { id } => {
                            if let Some(token) = active.get(&id) { token.cancel(); }
                        }
                        _ => return Err(Error::Protocol("unexpected client message".into())),
                    }
                }
            }
        }
    }.await;
    closed.cancel();
    tasks.shutdown().await;
    drop(outgoing);
    let _ = write_task.await;
    result
}

struct ActiveStream {
    cancellation: CancellationToken,
    credits: mpsc::Sender<u32>,
}

/// Serve one trusted peer with credit-based response streaming. Each stream uses one
/// in-flight slot until it ends or is cancelled; workers cannot send more chunks
/// than the host has credited.
pub async fn serve_stream<H, F, S>(
    stream: UnixStream,
    config: Config,
    handler: H,
) -> Result<(), Error>
where
    H: Fn(StreamInvocation) -> F + Send + Sync + 'static,
    F: Future<Output = Result<S, RemoteError>> + Send + 'static,
    S: Stream<Item = Result<Bytes, RemoteError>> + Send + Unpin + 'static,
{
    let (socket, frame_limit) = wire::handshake(stream, &config, true).await?;
    let (mut writer, mut reader) = socket.split();
    let closed = CancellationToken::new();
    let _guard = ConnectionGuard(closed.clone());
    let (outgoing, mut queue) = mpsc::channel::<Bytes>(config.max_in_flight);
    let writer_closed = closed.clone();
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = writer_closed.cancelled() => break,
                frame = queue.recv() => {
                    let Some(frame) = frame else { break };
                    let result = tokio::select! {
                        biased;
                        _ = writer_closed.cancelled() => break,
                        result = writer.send(frame) => result,
                    };
                    if result.is_err() { writer_closed.cancel(); break; }
                }
            }
        }
    });
    let handler = Arc::new(handler);
    let mut tasks = JoinSet::new();
    let mut active: HashMap<u64, ActiveStream> = HashMap::new();
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = closed.cancelled() => return Err(Error::Disconnected),
                result = tasks.join_next(), if !tasks.is_empty() => {
                    let Some(result) = result else {
                        return Err(Error::Protocol("worker stream task set ended unexpectedly".into()));
                    };
                    let (id, result) = result
                        .map_err(|e| Error::Protocol(format!("worker stream handler failed: {e}")))?;
                    active.remove(&id);
                    result?;
                }
                frame = reader.next() => {
                    let Some(frame) = frame else { return Ok(()) };
                    match wire::decode(&frame.map_err(Error::io)?)? {
                        Message::StreamInvoke { id, function, payload, timeout_ms, initial_credit } => {
                            if id == 0 || active.contains_key(&id) || timeout_ms == 0 || initial_credit == 0 {
                                return Err(Error::Protocol("invalid or duplicate stream ID/deadline/credit".into()));
                            }
                            if active.len() >= config.max_in_flight {
                                let reply = Message::StreamEnd { id, result: Err(RemoteError::new(ErrorKind::Overloaded, "worker capacity exhausted")) };
                                outgoing.try_send(wire::encode(&reply, frame_limit)?)
                                    .map_err(|_| Error::Overloaded)?;
                                continue;
                            }
                            let cancellation = closed.child_token();
                            let (credit_tx, credit_rx) = mpsc::channel::<u32>(config.stream_window);
                            credit_tx.try_send(initial_credit).map_err(|_| Error::Protocol("initial stream credit rejected".into()))?;
                            active.insert(id, ActiveStream { cancellation: cancellation.clone(), credits: credit_tx });
                            let timeout = Duration::from_millis(timeout_ms).min(config.max_request_timeout);
                            let handler = handler.clone();
                            let outgoing = outgoing.clone();
                            let task_closed = closed.clone();
                            tasks.spawn(async move {
                                let invocation = StreamInvocation { function, payload, cancellation: cancellation.clone() };
                                let result = run_stream_handler(
                                    id,
                                    invocation,
                                    handler,
                                    credit_rx,
                                    outgoing,
                                    frame_limit,
                                    timeout,
                                    task_closed,
                                ).await;
                                (id, result)
                            });
                        }
                        Message::StreamCredit { id, additional } => {
                            if additional == 0 {
                                return Err(Error::Protocol("invalid zero stream credit".into()));
                            }
                            let Some(stream) = active.get(&id) else { continue };
                            stream.credits.try_send(additional)
                                .map_err(|_| Error::Protocol("stream credit queue exceeded".into()))?;
                        }
                        Message::Cancel { id } => {
                            if let Some(stream) = active.get(&id) { stream.cancellation.cancel(); }
                        }
                        _ => return Err(Error::Protocol("unexpected client message".into())),
                    }
                }
            }
        }
    }.await;
    closed.cancel();
    tasks.shutdown().await;
    drop(outgoing);
    let _ = write_task.await;
    result
}

async fn run_stream_handler<H, F, S>(
    id: u64,
    invocation: StreamInvocation,
    handler: Arc<H>,
    mut credits: mpsc::Receiver<u32>,
    outgoing: mpsc::Sender<Bytes>,
    frame_limit: usize,
    timeout: Duration,
    closed: CancellationToken,
) -> Result<(), Error>
where
    H: Fn(StreamInvocation) -> F + Send + Sync + 'static,
    F: Future<Output = Result<S, RemoteError>> + Send + 'static,
    S: Stream<Item = Result<Bytes, RemoteError>> + Send + Unpin + 'static,
{
    let cancellation = invocation.cancellation.clone();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let stream = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(RemoteError::new(ErrorKind::Cancelled, "stream cancelled")),
        _ = &mut deadline => {
            cancellation.cancel();
            Err(RemoteError::new(ErrorKind::Deadline, "worker stream deadline exceeded"))
        }
        result = handler(invocation) => result,
    };
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(error) => return send_stream_end(id, Err(error), outgoing, frame_limit, &closed).await,
    };
    let mut credit_budget = 0u64;
    loop {
        while credit_budget == 0 {
            credit_budget += tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return send_stream_end(id, Err(RemoteError::new(ErrorKind::Cancelled, "stream cancelled")), outgoing, frame_limit, &closed).await;
                }
                _ = &mut deadline => {
                    cancellation.cancel();
                    return send_stream_end(id, Err(RemoteError::new(ErrorKind::Deadline, "worker stream deadline exceeded")), outgoing, frame_limit, &closed).await;
                }
                credit = credits.recv() => credit.ok_or(Error::Disconnected)? as u64,
            };
        }
        let item = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(RemoteError::new(ErrorKind::Cancelled, "stream cancelled")),
            _ = &mut deadline => {
                cancellation.cancel();
                Err(RemoteError::new(ErrorKind::Deadline, "worker stream deadline exceeded"))
            }
            item = stream.next() => match item {
                Some(item) => item,
                None => return send_stream_end(id, Ok(()), outgoing, frame_limit, &closed).await,
            },
        };
        let chunk = match item {
            Ok(chunk) => chunk,
            Err(error) => {
                return send_stream_end(id, Err(error), outgoing, frame_limit, &closed).await
            }
        };
        credit_budget -= 1;
        let frame = wire::encode(&Message::StreamChunk { id, chunk }, frame_limit)?;
        tokio::select! {
            biased;
            _ = closed.cancelled() => return Err(Error::Disconnected),
            result = outgoing.send(frame) => result.map_err(|_| Error::Disconnected)?,
        }
    }
}

async fn send_stream_end(
    id: u64,
    result: Result<(), RemoteError>,
    outgoing: mpsc::Sender<Bytes>,
    frame_limit: usize,
    closed: &CancellationToken,
) -> Result<(), Error> {
    let frame = wire::encode(&Message::StreamEnd { id, result }, frame_limit)?;
    tokio::select! {
        biased;
        _ = closed.cancelled() => Err(Error::Disconnected),
        result = outgoing.send(frame) => result.map_err(|_| Error::Disconnected),
    }
}
