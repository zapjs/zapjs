use napi::{
    bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, BigInt, Buffer, BufferSlice},
    Env, Error, Result,
};
use napi_derive::napi;
use std::{
    num::NonZeroUsize,
    sync::OnceLock,
    time::{Duration, Instant},
};
use zap_native::{Cancellation, ComputePool};

#[napi(object)]
pub struct RequestMetadata {
    pub request_id: String,
    pub authorization: Option<String>,
}

#[napi(object)]
pub struct Summary {
    pub sum: f64,
    pub count: u32,
    pub request_id: String,
    pub authenticated: bool,
}

#[napi(strict)]
pub async fn summarize(values: Vec<f64>, context: RequestMetadata) -> Result<Summary> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(Error::from_reason("Values must be finite"));
    }
    zap_native::compute(move |token| {
        let mut sum = 0.0;
        for chunk in values.chunks(1024) {
            token.check()?;
            sum += chunk.iter().sum::<f64>();
        }
        Ok(Summary {
            sum,
            count: values.len() as u32,
            request_id: context.request_id,
            authenticated: context.authorization.is_some(),
        })
    })
    .await
    .map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(strict)]
pub fn reverse_bytes(env: &Env, input: BufferSlice<'_>) -> Result<AsyncBlock<Buffer>> {
    // Snapshot JS-owned bytes on the JS thread before any asynchronous execution.
    let mut bytes = input.to_vec();
    AsyncBlockBuilder::new(async move {
        zap_native::compute(move |_| {
            bytes.reverse();
            Ok(bytes)
        })
        .await
        .map(Buffer::from)
        .map_err(|error| Error::from_reason(error.to_string()))
    })
    .build(env)
}

#[napi(strict)]
pub fn exact_integer(value: BigInt) -> BigInt {
    value
}

#[napi]
pub struct Work {
    token: Cancellation,
}

#[napi]
impl Work {
    #[napi(constructor)]
    pub fn new(timeout_ms: u32) -> Self {
        Self {
            token: Cancellation::with_timeout(Duration::from_millis(timeout_ms as u64)),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.token.cancel();
    }

    #[napi]
    pub async fn run(&self, duration_ms: u32) -> Result<u32> {
        static POOL: OnceLock<ComputePool> = OnceLock::new();
        let pool = POOL.get_or_init(|| ComputePool::new(NonZeroUsize::new(2).unwrap()));
        pool.run(self.token.clone(), move |token| {
            let until = Instant::now() + Duration::from_millis(duration_ms as u64);
            while Instant::now() < until {
                token.check()?;
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(duration_ms)
        })
        .await
        .map_err(|error| Error::from_reason(error.to_string()))
    }
}
