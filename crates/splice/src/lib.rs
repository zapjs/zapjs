//! Splice connects Rust-owned workers without a public RPC port or a separately
//! operated service. Use direct Rust calls within one process; use this transport only
//! where process isolation or binary replacement requires a worker boundary.
//!
//! Version 2 deliberately advertises only bounded unary invocation and cancellation.
//! It is not wire compatible with the incomplete legacy version 1 streaming protocol.
//! Handlers must be asynchronous and yield: cancellation cannot preempt blocking Rust.

mod client;
mod server;
mod wire;

pub use client::Client;
use serde::{Deserialize, Serialize};
pub use server::{serve, Invocation};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub max_frame_bytes: usize,
    pub max_in_flight: usize,
    pub handshake_timeout: Duration,
    pub max_request_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_frame_bytes: 1024 * 1024,
            max_in_flight: 64,
            handshake_timeout: Duration::from_secs(5),
            max_request_timeout: Duration::from_secs(30),
        }
    }
}

impl Config {
    fn validate(&self) -> Result<(), Error> {
        if !(512..=16 * 1024 * 1024).contains(&self.max_frame_bytes)
            || !(1..=4096).contains(&self.max_in_flight)
            || self.handshake_timeout.is_zero()
            || self.max_request_timeout.is_zero()
            || self.handshake_timeout > Duration::from_secs(3600)
            || self.max_request_timeout > Duration::from_secs(3600)
        {
            return Err(Error::Protocol("invalid Splice limits".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorKind {
    Application,
    Cancelled,
    Deadline,
    Overloaded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteError {
    pub kind: ErrorKind,
    pub message: String,
}

impl RemoteError {
    pub fn application(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Application,
            message: message.into(),
        }
    }
    fn new(kind: ErrorKind, message: &str) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    #[error("Splice peer disconnected")]
    Disconnected,
    #[error("Splice request deadline exceeded")]
    Deadline,
    #[error("Splice capacity exhausted")]
    Overloaded,
    #[error("Splice frame exceeds negotiated size limit")]
    FrameTooLarge,
    #[error("Splice protocol error: {0}")]
    Protocol(String),
    #[error("Splice remote {0:?}")]
    Remote(RemoteError),
}

impl Error {
    fn io(error: std::io::Error) -> Self {
        Self::Protocol(error.to_string())
    }
}
