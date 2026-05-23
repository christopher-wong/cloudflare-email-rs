use serde::Serialize;
use worker::{Response, Result};

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl ApiError {
    pub fn status(&self) -> u16 {
        match self {
            ApiError::BadRequest(_) => 400,
            ApiError::Unauthorized => 401,
            ApiError::Forbidden => 403,
            ApiError::NotFound => 404,
            ApiError::Conflict(_) => 409,
            ApiError::Internal(_) => 500,
        }
    }
}

#[derive(Serialize)]
struct ErrBody<'a> {
    error: &'a str,
}

pub fn to_response(err: ApiError) -> Result<Response> {
    let body = ErrBody { error: &err.to_string() };
    Response::from_json(&body).map(|r| r.with_status(err.status()))
}

#[allow(dead_code)]
pub fn bad_request(msg: impl Into<String>) -> ApiError {
    ApiError::BadRequest(msg.into())
}

pub fn internal(msg: impl Into<String>) -> ApiError {
    ApiError::Internal(msg.into())
}

impl From<worker::Error> for ApiError {
    fn from(e: worker::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::BadRequest(e.to_string())
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;
