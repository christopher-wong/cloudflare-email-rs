//! Typed, prefixed identifiers — Stripe-style.
//!
//! Two flavors:
//!
//! **KSUID-backed** (sortable, embeds creation time) — used for resource IDs.
//! Format: `<prefix>_<27-char base62 ksuid>`.
//! Example: `user_2t0w7Lh3RfYbT9mXkP1Q4qH8sZj`.
//!
//! **Random-token-backed** (32 bytes base64url, ~192 bits entropy) — used
//! for opaque secrets where time-sortability would leak signal. Sessions,
//! invites, and short-lived challenges.
//! Format: `<prefix>_<43-char base64url>`.
//! Example: `sid_AbCDefGhI...`.
//!
//! KSUID spec: https://github.com/segmentio/ksuid (20 bytes binary,
//! 4-byte big-endian seconds since 2014-05-13, 16-byte random tail).

use rand_core::{OsRng, RngCore};
use worker::Date;

const EPOCH_SECS: u64 = 1_400_000_000;
const ALPHABET: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KSUID_CHARS: usize = 27;

// ---- Raw generators -------------------------------------------------------

/// Bare KSUID — 27 base62 chars, no prefix. Use for path components inside
/// R2 keys, where the prefix would be redundant.
pub fn ksuid() -> String {
    let now_secs = (Date::now().as_millis() / 1000) as u64;
    let ts = now_secs.saturating_sub(EPOCH_SECS) as u32;
    let mut bytes = [0u8; 20];
    bytes[0..4].copy_from_slice(&ts.to_be_bytes());
    OsRng.fill_bytes(&mut bytes[4..]);
    base62_encode(&bytes)
}

/// 32 random bytes, base64url-encoded (43 chars, no padding).
pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    OsRng.fill_bytes(&mut buf);
    crate::b64::url_encode(&buf)
}

// ---- Typed resource IDs (KSUID-backed) ------------------------------------

pub fn user()       -> String { with_prefix("user", &ksuid()) }
pub fn message()    -> String { with_prefix("msg",  &ksuid()) }
pub fn thread()     -> String { with_prefix("thr",  &ksuid()) }
pub fn draft()      -> String { with_prefix("drft", &ksuid()) }
pub fn label()      -> String { with_prefix("lbl",  &ksuid()) }
pub fn attachment() -> String { with_prefix("att",  &ksuid()) }
pub fn wrap()       -> String { with_prefix("wrap", &ksuid()) }

// ---- Typed tokens (random-backed) -----------------------------------------

pub fn session()   -> String { with_prefix("sid", &random_token()) }
pub fn invite()    -> String { with_prefix("inv", &random_token()) }
pub fn challenge() -> String { with_prefix("chl", &random_token()) }

// ---- Inspection -----------------------------------------------------------

/// Pull the prefix off an id, e.g. `prefix_of("user_2t0w…") == Some("user")`.
/// Returns None if no underscore is present.
#[allow(dead_code)]
pub fn prefix_of(id: &str) -> Option<&str> {
    id.split_once('_').map(|(p, _)| p)
}

#[inline]
fn with_prefix(prefix: &str, tail: &str) -> String {
    let mut s = String::with_capacity(prefix.len() + 1 + tail.len());
    s.push_str(prefix);
    s.push('_');
    s.push_str(tail);
    s
}

// ---- Base62 (KSUID encoding) ----------------------------------------------

fn base62_encode(input: &[u8; 20]) -> String {
    let mut digits = [b'0'; KSUID_CHARS];
    let mut num = *input;
    let mut write_idx = KSUID_CHARS;

    loop {
        let mut remainder: u32 = 0;
        let mut all_zero = true;
        for byte in num.iter_mut() {
            let acc = (remainder << 8) | *byte as u32;
            *byte = (acc / 62) as u8;
            remainder = acc % 62;
            if *byte != 0 {
                all_zero = false;
            }
        }
        write_idx -= 1;
        digits[write_idx] = ALPHABET[remainder as usize];
        if all_zero {
            break;
        }
    }

    String::from_utf8(digits.to_vec()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_zero_to_all_zeros() {
        let s = base62_encode(&[0u8; 20]);
        assert_eq!(s, "0".repeat(27));
    }

    #[test]
    fn prefix_extraction() {
        assert_eq!(prefix_of("user_abc"), Some("user"));
        assert_eq!(prefix_of("drft_xyz"), Some("drft"));
        assert_eq!(prefix_of("nope"), None);
    }

    // ksuid() calls worker::Date::now(), a wasm-bindgen extern that
    // panics on the native target with "cannot call wasm-bindgen imported
    // functions on non-wasm targets". Only run this test under wasm.
    #[cfg(target_arch = "wasm32")]
    #[test]
    fn ksuid_shape() {
        let id = user();
        assert!(id.starts_with("user_"));
        // user_ + 27-char ksuid = 32 chars
        assert_eq!(id.len(), 5 + 27);
    }
}
