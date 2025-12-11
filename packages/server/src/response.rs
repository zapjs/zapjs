//! Response types and utilities for ZapServer

use std::collections::HashMap;
use std::path::PathBuf;

use bytes::Bytes;
use serde::Serialize;

use zap_core::{Response, StatusCode, ResponseBody};

/// Streaming response data
#[derive(Debug)]
pub struct StreamingResponse {
    /// HTTP status code
    pub status: u16,
    /// Response headers
    pub headers: HashMap<String, String>,
    /// Collected body chunks (base64 decoded)
    pub chunks: Vec<Vec<u8>>,
}

impl StreamingResponse {
    /// Create a new streaming response
    pub fn new(status: u16, headers: HashMap<String, String>) -> Self {
        Self {
            status,
            headers,
            chunks: Vec::new(),
        }
    }

    /// Add a chunk to the response
    pub fn add_chunk(&mut self, data: Vec<u8>) {
        self.chunks.push(data);
    }

    /// Get the complete body as bytes
    pub fn body_bytes(&self) -> Vec<u8> {
        let total_len: usize = self.chunks.iter().map(|c| c.len()).sum();
        let mut body = Vec::with_capacity(total_len);
        for chunk in &self.chunks {
            body.extend_from_slice(chunk);
        }
        body
    }

    /// Get the complete body as a string (lossy conversion)
    pub fn body_string(&self) -> String {
        String::from_utf8_lossy(&self.body_bytes()).to_string()
    }
}

/// Zap response types with auto-serialization
#[derive(Debug)]
pub enum ZapResponse {
    /// Plain text response
    Text(String),
    /// HTML response
    Html(String),
    /// JSON response (auto-serialized)
    Json(serde_json::Value),
    /// JSON response with custom status code
    JsonWithStatus(serde_json::Value, u16),
    /// Binary response
    Bytes(Bytes),
    /// File response
    File(PathBuf),
    /// Custom response with full control
    Custom(Response),
    /// Redirect response
    Redirect(String),
    /// Empty response with status code
    Status(StatusCode),
    /// Streaming response (collected chunks)
    Stream(StreamingResponse),
}

/// JSON response wrapper for auto-serialization
#[derive(Debug)]
pub struct Json<T>(pub T);

impl<T: Serialize> From<Json<T>> for ZapResponse {
    fn from(json: Json<T>) -> Self {
        match serde_json::to_value(json.0) {
            Ok(value) => ZapResponse::Json(value),
            Err(_) => ZapResponse::Custom(
                Response::internal_server_error("Failed to serialize JSON"),
            ),
        }
    }
}

impl ZapResponse {
    /// Convert ZapResponse to hyper Response
    pub fn to_hyper_response(&self) -> hyper::Response<String> {
        match self {
            ZapResponse::Text(text) => hyper::Response::builder()
                .status(200)
                .header("Content-Type", "text/plain; charset=utf-8")
                .body(text.clone())
                .unwrap(),
            ZapResponse::Html(html) => hyper::Response::builder()
                .status(200)
                .header("Content-Type", "text/html; charset=utf-8")
                .body(html.clone())
                .unwrap(),
            ZapResponse::Json(json) => {
                let body = serde_json::to_string(json).unwrap_or_else(|_| {
                    r#"{"error": "Failed to serialize JSON"}"#.to_string()
                });
                hyper::Response::builder()
                    .status(200)
                    .header("Content-Type", "application/json")
                    .body(body)
                    .unwrap()
            }
            ZapResponse::JsonWithStatus(json, status) => {
                let body = serde_json::to_string(json).unwrap_or_else(|_| {
                    r#"{"error": "Failed to serialize JSON"}"#.to_string()
                });
                hyper::Response::builder()
                    .status(*status)
                    .header("Content-Type", "application/json")
                    .body(body)
                    .unwrap()
            }
            ZapResponse::Bytes(bytes) => hyper::Response::builder()
                .status(200)
                .header("Content-Type", "application/octet-stream")
                .body(String::from_utf8_lossy(bytes).to_string())
                .unwrap(),
            ZapResponse::Custom(response) => {
                let status = response.status.as_u16();
                let mut builder = hyper::Response::builder().status(status);
                
                for (key, value) in &response.headers {
                    builder = builder.header(key, value);
                }
                
                let body = match &response.body {
                    ResponseBody::Empty => String::new(),
                    ResponseBody::Text(text) => text.clone(),
                    ResponseBody::Bytes(bytes) => {
                        String::from_utf8_lossy(bytes).to_string()
                    }
                };
                
                builder.body(body).unwrap()
            }
            ZapResponse::Redirect(location) => hyper::Response::builder()
                .status(302)
                .header("Location", location)
                .body(String::new())
                .unwrap(),
            ZapResponse::Status(status) => hyper::Response::builder()
                .status(status.as_u16())
                .body(String::new())
                .unwrap(),
            ZapResponse::File(_path) => {
                // File serving would be implemented here
                // For now, return not implemented
                hyper::Response::builder()
                    .status(501)
                    .body("File serving not yet implemented".to_string())
                    .unwrap()
            }
            ZapResponse::Stream(stream_response) => {
                let mut builder = hyper::Response::builder()
                    .status(stream_response.status);

                // Add all headers from the streaming response
                for (key, value) in &stream_response.headers {
                    builder = builder.header(key, value);
                }

                // Convert chunks to body
                let body = stream_response.body_string();
                builder.body(body).unwrap()
            }
        }
    }
} 