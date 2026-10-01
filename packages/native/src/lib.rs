//! In-process compute primitives for Node-API modules.
//!
//! Export application functions with `napi_derive::napi`; napi-rs owns value
//! conversion, JavaScript lifetime handling, and generated TypeScript types.
//! Use [`ComputePool`] for substantial CPU work instead of running it on the
//! JavaScript thread or an asynchronous runtime worker. Cancellation is cooperative.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ComputeError {
    #[error("ZAP_NATIVE_OVERLOADED: native work capacity exhausted")]
    Overloaded,
    #[error("ZAP_NATIVE_CANCELLED: native operation cancelled")]
    Cancelled,
    #[error("ZAP_NATIVE_DEADLINE: native operation deadline exceeded")]
    DeadlineExceeded,
    #[error("ZAP_NATIVE_PANIC: native operation panicked")]
    Panicked,
    #[error("ZAP_NATIVE_RUNTIME: native runtime stopped")]
    RuntimeStopped,
}

/// Shared cancellation and optional monotonic deadline. Pass a clone into work;
/// call `check()` at bounded intervals. A cancelled token cannot be reused.
#[derive(Clone, Debug)]
pub struct Cancellation {
    cancelled: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl Default for Cancellation {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: None,
        }
    }
}

impl Cancellation {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            deadline: Instant::now().checked_add(timeout),
            ..Self::default()
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), ComputeError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ComputeError::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(ComputeError::DeadlineExceeded);
        }
        Ok(())
    }
}

struct CancelOnDrop(Option<Cancellation>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.0 {
            cancellation.cancel();
        }
    }
}

/// Bounds all admitted work, including work still executing after its future is
/// dropped. There is no unbounded waiting queue: saturation returns `Overloaded`.
#[derive(Clone)]
pub struct ComputePool {
    permits: Arc<Semaphore>,
}

impl ComputePool {
    pub fn new(capacity: std::num::NonZeroUsize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity.get())),
        }
    }

    pub async fn run<T, F>(&self, cancellation: Cancellation, work: F) -> Result<T, ComputeError>
    where
        T: Send + 'static,
        F: FnOnce(Cancellation) -> Result<T, ComputeError> + Send + 'static,
    {
        cancellation.check()?;
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| ComputeError::Overloaded)?;
        let mut cancel_on_drop = CancelOnDrop(Some(cancellation.clone()));
        let result = tokio::task::spawn_blocking(move || {
            // The real operation owns the permit; dropping a JS Promise must not
            // permit replacement work while the old native computation still runs.
            let _permit = permit;
            cancellation.check()?;
            let result = work(cancellation.clone())?;
            cancellation.check()?;
            Ok(result)
        })
        .await;
        // Completing one operation must not cancel other work sharing its scope.
        // Keep the guard armed only while dropping this future would abandon work.
        cancel_on_drop.0 = None;
        result.map_err(|error| {
            if error.is_panic() {
                ComputeError::Panicked
            } else {
                ComputeError::RuntimeStopped
            }
        })?
    }
}

/// Process-local default capacity is bounded by available CPUs, capped at 32.
/// Applications needing a different limit can own an explicit `ComputePool`.
pub async fn compute<T, F>(work: F) -> Result<T, ComputeError>
where
    T: Send + 'static,
    F: FnOnce(Cancellation) -> Result<T, ComputeError> + Send + 'static,
{
    static POOL: OnceLock<ComputePool> = OnceLock::new();
    let pool = POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .min(32);
        ComputePool::new(std::num::NonZeroUsize::new(cores).unwrap())
    });
    pool.run(Cancellation::default(), work).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn admission_remains_held_until_cancelled_work_actually_finishes() {
        let pool = ComputePool::new(std::num::NonZeroUsize::new(1).unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let token = Cancellation::default();
        let running = tokio::spawn({
            let pool = pool.clone();
            let token = token.clone();
            async move {
                pool.run(token, move |_| {
                    let _ = started_tx.send(());
                    finish_rx.recv().unwrap();
                    Ok(7)
                })
                .await
            }
        });
        started_rx.await.unwrap();
        running.abort();
        let _ = running.await;
        assert_eq!(token.check(), Err(ComputeError::Cancelled));
        assert_eq!(
            pool.run(Cancellation::default(), |_| Ok(0)).await,
            Err(ComputeError::Overloaded)
        );
        finish_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if pool.run(Cancellation::default(), |_| Ok(9)).await == Ok(9) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn completed_work_does_not_cancel_a_shared_scope() {
        let pool = ComputePool::new(std::num::NonZeroUsize::new(2).unwrap());
        let scope = Cancellation::default();
        assert_eq!(pool.run(scope.clone(), |_| Ok(1)).await, Ok(1));
        assert_eq!(scope.check(), Ok(()));
        assert_eq!(pool.run(scope.clone(), |_| Ok(2)).await, Ok(2));
        scope.cancel();
        assert_eq!(
            pool.run(scope, |_| Ok(3)).await,
            Err(ComputeError::Cancelled)
        );
    }

    #[tokio::test]
    async fn panics_release_capacity_and_deadlines_reject_work() {
        let pool = ComputePool::new(std::num::NonZeroUsize::new(1).unwrap());
        assert_eq!(
            pool.run(Cancellation::default(), |_| -> Result<(), ComputeError> {
                panic!("fixture panic")
            })
            .await,
            Err(ComputeError::Panicked)
        );
        assert_eq!(
            pool.run(Cancellation::with_timeout(Duration::ZERO), |_| Ok(1))
                .await,
            Err(ComputeError::DeadlineExceeded)
        );
        assert_eq!(pool.run(Cancellation::default(), |_| Ok(2)).await, Ok(2));
    }
}
