use crate::{Config, Error, RemoteError};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tokio::net::UnixStream;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

const VERSION: u16 = 2;
pub(crate) type Socket = Framed<UnixStream, LengthDelimitedCodec>;

#[derive(Serialize, Deserialize)]
pub(crate) enum Message {
    Hello {
        version: u16,
        server: bool,
        max_frame: u32,
    },
    Invoke {
        id: u64,
        function: String,
        payload: Bytes,
        timeout_ms: u64,
    },
    Result {
        id: u64,
        result: Result<Bytes, RemoteError>,
    },
    Cancel {
        id: u64,
    },
}

pub(crate) fn encode(message: &Message, limit: usize) -> Result<Bytes, Error> {
    // Reject large raw fields before serialization can allocate another payload copy.
    let raw_size = match message {
        Message::Invoke {
            function, payload, ..
        } => function.len().saturating_add(payload.len()),
        Message::Result {
            result: Ok(payload),
            ..
        } => payload.len(),
        Message::Result {
            result: Err(error), ..
        } => error.message.len(),
        _ => 0,
    };
    if raw_size > limit {
        return Err(Error::FrameTooLarge);
    }
    let bytes = rmp_serde::to_vec(message).map_err(|e| Error::Protocol(e.to_string()))?;
    if bytes.len() > limit {
        return Err(Error::FrameTooLarge);
    }
    Ok(bytes.into())
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Message, Error> {
    let mut cursor = Cursor::new(bytes);
    let message = rmp_serde::from_read(&mut cursor).map_err(|e| Error::Protocol(e.to_string()))?;
    if cursor.position() != bytes.len() as u64 {
        return Err(Error::Protocol("trailing bytes in message".into()));
    }
    Ok(message)
}

pub(crate) async fn handshake(
    stream: UnixStream,
    config: &Config,
    server: bool,
) -> Result<(Socket, usize), Error> {
    config.validate()?;
    let mut socket = Framed::new(
        stream,
        LengthDelimitedCodec::builder()
            .max_frame_length(config.max_frame_bytes)
            .new_codec(),
    );
    let hello = encode(
        &Message::Hello {
            version: VERSION,
            server,
            max_frame: config.max_frame_bytes as u32,
        },
        config.max_frame_bytes,
    )?;
    let limit = tokio::time::timeout(config.handshake_timeout, async {
        // Both peers send first. Hello is tiny, independent of request capacity.
        socket.send(hello).await.map_err(Error::io)?;
        let bytes = socket
            .next()
            .await
            .ok_or(Error::Disconnected)?
            .map_err(Error::io)?;
        match decode(&bytes)? {
            Message::Hello {
                version: VERSION,
                server: peer_server,
                max_frame,
            } if peer_server != server && (512..=16 * 1024 * 1024).contains(&max_frame) => {
                Ok(config.max_frame_bytes.min(max_frame as usize))
            }
            _ => Err(Error::Protocol("incompatible Splice handshake".into())),
        }
    })
    .await
    .map_err(|_| Error::Deadline)??;
    socket.codec_mut().set_max_frame_length(limit);
    Ok((socket, limit))
}
