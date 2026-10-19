//! One error type for the whole service: every handler returns it, and it always
//! serializes as JSON. Upstream RPC problems become 503 (never a panic, never a
//! bare 500 with an empty body).

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub detail: Option<Value>,
    pub summary: Vec<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), detail: None, summary: Vec::new() }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn with_summary(mut self, summary: Vec<String>) -> Self {
        self.summary = summary;
        self
    }

    /// An RPC endpoint failed (transport, HTTP status, JSON-RPC error, or a
    /// response shape we could not decode). Always 503 per the service contract.
    pub fn upstream(service: &str, detail: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "upstream_rpc_error",
            message: format!("{service} RPC call failed"),
            detail: Some(json!({ "service": service, "reason": detail.to_string() })),
            summary: Vec::new(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({
            "ok": false,
            "error": self.code,
            "message": self.message,
            "detail": self.detail.unwrap_or(Value::Null),
            "summary": self.summary,
        });
        (self.status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
