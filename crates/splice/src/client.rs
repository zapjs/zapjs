use crate::{
    wire::{self, Message},
    Config, Error,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tokio::{
    net::UnixStream,
    sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore},
};
use tokio_util::sync::CancellationToken;

type Reply = oneshot::Sender<Result<Bytes, Error>>;
struct Pending {
    reply: Reply,
    _permit: OwnedSemaphorePermit,
}
struct Core {
    pending: Mutex<HashMap<u64, Pending>>,
    outgoing: mpsc::Sender<Bytes>,
    closed: CancellationToken,
    sequence: AtomicU64,
    capacity: Arc<Semaphore>,
    frame_limit: usize,
    timeout_limit: Duration,
}

impl Core {
    fn pending(&self) -> MutexGuard<'_, HashMap<u64, Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn finish(&self, id: u64, result: Result<Bytes, Error>) {
        let pending = self.pending().remove(&id);
        if let Some(pending) = pending {
            let _ = pending.reply.send(result);
        }
    }

    fn fail(&self, error: Error) {
        self.closed.cancel();
        let pending = std::mem::take(&mut *self.pending());
        for (_, request) in pending {
            let _ = request.reply.send(Err(error.clone()));
        }
    }
}

struct Owner(Arc<Core>);
impl Drop for Owner {
    fn drop(&mut self) {
        self.0.fail(Error::Disconnected);
    }
}

/// Cloning shares one multiplexed connection; dropping its final handle closes it.
#[derive(Clone)]
pub struct Client(Arc<Owner>);

struct RequestGuard {
    core: Arc<Core>,
    id: u64,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        // A terminal response already removed the entry. Call-drop and timeout remove
        // their own entry exactly once, release capacity, and notify the worker.
        let pending = self.core.pending().remove(&self.id);
        if pending.is_some() {
            let cancel = match wire::encode(&Message::Cancel { id: self.id }, self.core.frame_limit)
            {
                Ok(cancel) => cancel,
                Err(error) => {
                    self.core.fail(error);
                    return;
                }
            };
            if self.core.outgoing.try_send(cancel).is_err() {
                // Never silently abandon a cancellation behind a saturated writer.
                self.core.fail(Error::Disconnected);
            }
        }
    }
}

impl Client {
    pub async fn connect(stream: UnixStream, config: Config) -> Result<Self, Error> {
        let (socket, frame_limit) = wire::handshake(stream, &config, false).await?;
        let (outgoing, mut queue) = mpsc::channel::<Bytes>(config.max_in_flight * 2);
        let core = Arc::new(Core {
            pending: Mutex::new(HashMap::new()),
            outgoing,
            closed: CancellationToken::new(),
            sequence: AtomicU64::new(1),
            capacity: Arc::new(Semaphore::new(config.max_in_flight)),
            frame_limit,
            timeout_limit: config.max_request_timeout,
        });
        let (mut writer, mut reader) = socket.split();
        let write_core = core.clone();
        tokio::spawn(async move {
            let result = async {
                loop {
                    tokio::select! {
                        biased;
                        _ = write_core.closed.cancelled() => return Ok(()),
                        frame = queue.recv() => {
                            let Some(frame) = frame else { return Ok(()) };
                            tokio::select! {
                                biased;
                                _ = write_core.closed.cancelled() => return Ok(()),
                                result = writer.send(frame) => result.map_err(Error::io)?,
                            }
                        }
                    }
                }
            }
            .await;
            write_core.fail(result.err().unwrap_or(Error::Disconnected));
        });
        let read_core = core.clone();
        tokio::spawn(async move {
            let result = async {
                loop {
                    let frame = tokio::select! {
                        biased;
                        _ = read_core.closed.cancelled() => return Ok(()),
                        frame = reader.next() => frame.ok_or(Error::Disconnected)?.map_err(Error::io)?,
                    };
                    match wire::decode(&frame)? {
                        Message::Result { id, result } => read_core.finish(id, result.map_err(Error::Remote)),
                        _ => return Err(Error::Protocol("unexpected worker message".into())),
                    }
                }
            }.await;
            read_core.fail(result.err().unwrap_or(Error::Disconnected));
        });
        Ok(Self(Arc::new(Owner(core))))
    }

    pub async fn invoke(
        &self,
        function: impl Into<String>,
        payload: Bytes,
        timeout: Duration,
    ) -> Result<Bytes, Error> {
        let core = &self.0 .0;
        if timeout.is_zero() {
            return Err(Error::Deadline);
        }
        let deadline = tokio::time::Instant::now() + timeout.min(core.timeout_limit);
        if core.closed.is_cancelled() {
            return Err(Error::Disconnected);
        }
        let permit = core
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Overloaded)?;
        let id = core
            .sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| Error::Protocol("request ID space exhausted".into()))?;
        let message = wire::encode(
            &Message::Invoke {
                id,
                function: function.into(),
                payload,
                timeout_ms: timeout.min(core.timeout_limit).as_millis().max(1) as u64,
            },
            core.frame_limit,
        )?;
        let (reply, response) = oneshot::channel();
        {
            let mut pending = core.pending();
            if core.closed.is_cancelled() {
                return Err(Error::Disconnected);
            }
            pending.insert(
                id,
                Pending {
                    reply,
                    _permit: permit,
                },
            );
        }
        let guard = RequestGuard {
            core: core.clone(),
            id,
        };
        if core.outgoing.try_send(message).is_err() {
            core.finish(id, Err(Error::Overloaded));
            return Err(Error::Overloaded);
        }
        let result = tokio::time::timeout_at(deadline, response)
            .await
            .map_err(|_| Error::Deadline)?
            .map_err(|_| Error::Disconnected)?;
        drop(guard);
        result
    }

    /// Close the entire connection, including every in-flight request.
    pub fn close(&self) {
        self.0 .0.fail(Error::Disconnected);
    }
}
