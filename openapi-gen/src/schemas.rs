//! Schemas live in the `cfemail-api-types` workspace crate so the
//! worker and the OpenAPI generator share one definition each. This
//! module is a glob re-export so the rest of `openapi-gen` (and the
//! `#[utoipa::path]` annotations) can refer to types by their bare
//! names exactly as before.
//!
//! If you're looking for a struct, it's in `api-types/src/lib.rs`.

pub use api_types::*;
