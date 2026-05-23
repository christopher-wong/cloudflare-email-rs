use base64::{engine::general_purpose, Engine};

pub fn url_encode(bytes: &[u8]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn url_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    // Accept either url-safe or padded; strip whitespace just in case
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    general_purpose::URL_SAFE_NO_PAD
        .decode(cleaned.trim_end_matches('='))
        .or_else(|_| general_purpose::URL_SAFE.decode(&cleaned))
        .or_else(|_| general_purpose::STANDARD.decode(&cleaned))
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(cleaned.trim_end_matches('=')))
}

#[allow(dead_code)]
pub fn std_encode(bytes: &[u8]) -> String {
    general_purpose::STANDARD.encode(bytes)
}
