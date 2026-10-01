use crate::{
    wire::{self, Message},
    Config, Error, ErrorKind, RemoteError,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
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
