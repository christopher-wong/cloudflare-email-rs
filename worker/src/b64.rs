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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_arbitrary_bytes() {
        let bytes: &[u8] = &[0, 1, 2, 255, 128, 64, 32, 16, 8, 0xff, 0xfe];
        let encoded = url_encode(bytes);
        assert_eq!(url_decode(&encoded).unwrap(), bytes);
    }

    #[test]
    fn produces_url_safe_encoding() {
        // 0xfb 0xff 0xff in standard base64 yields '+', '/'. URL-safe must not.
        let s = url_encode(&[0xfb, 0xff, 0xff]);
        assert!(!s.contains('+'));
        assert!(!s.contains('/'));
        assert!(!s.contains('='));
    }

    #[test]
    fn decode_accepts_padded_input() {
        // Same data, encoded both ways. Both must round-trip.
        let plain = b"Hello, World!";
        let unpadded = url_encode(plain);
        let padded = format!("{}=", unpadded); // append a stray '=' as some senders do
        assert_eq!(url_decode(&unpadded).unwrap(), plain);
        assert_eq!(url_decode(&padded).unwrap(), plain);
    }

    #[test]
    fn decode_accepts_whitespace() {
        // Email headers wrap base64 at 76 chars with CRLFs.
        let plain = b"twelve bytes";
        let with_ws = format!(" {} \n", url_encode(plain));
        assert_eq!(url_decode(&with_ws).unwrap(), plain);
    }

    #[test]
    fn roundtrips_empty_buffer() {
        assert_eq!(url_decode(&url_encode(&[])).unwrap(), Vec::<u8>::new());
    }
}
