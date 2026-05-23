//! Server-side encryption to user X25519 public keys. Sealed-box semantics:
//! ephemeral keypair per message, X25519 ECDH, HKDF-SHA256 to a 32-byte AEAD
//! key, XChaCha20-Poly1305 for the encrypt. Wire format:
//!
//!     ephemeral_pub (32) ‖ nonce (24) ‖ ciphertext+tag
//!
//! The server never holds a private key. The client decrypts after passkey
//! login unwraps its X25519 secret.

use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha512};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{internal, ApiResult};

pub fn seal_to(pubkey: &[u8; 32], plaintext: &[u8]) -> ApiResult<Vec<u8>> {
    let recipient = PublicKey::from(*pubkey);
    let eph_secret = StaticSecret::random_from_rng(OsRng);
    let eph_pub = PublicKey::from(&eph_secret);

    let shared = eph_secret.diffie_hellman(&recipient);

    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, shared.as_bytes());
    let mut aead_key = [0u8; 32];
    hk.expand(b"cfemail/sealed-box/v1", &mut aead_key)
        .map_err(|_| internal("hkdf expand"))?;

    // Deterministic nonce from (eph_pub ‖ recipient_pub); same construction
    // as libsodium's sealed-box (libsodium uses BLAKE2b — we use SHA-512 since
    // RustCrypto's BLAKE2b is a heavier dep). The nonce only needs to be
    // unique per (eph, recipient); since `eph_pub` is fresh per encrypt, this
    // is automatically satisfied.
    let mut h = Sha512::new();
    h.update(eph_pub.as_bytes());
    h.update(pubkey);
    let digest = h.finalize();
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&digest[..24]);

    let cipher = XChaCha20Poly1305::new(&aead_key.into());
    let ciphertext = cipher
        .encrypt((&nonce).into(), plaintext)
        .map_err(|_| internal("aead encrypt"))?;

    let mut out = Vec::with_capacity(32 + 24 + ciphertext.len());
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    OsRng.fill_bytes(&mut buf);
    buf
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
