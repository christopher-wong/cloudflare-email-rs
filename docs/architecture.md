# System Architecture — bmail / cfemail

This document describes the **static structure** and **major data flows** of the application. It is the best starting point for both humans and coding agents.

## 1. High-Level Component Diagram

```mermaid
block-beta
  columns 3

  block:Browser:3
    direction TB
    SPA["React + Vite SPA\n(assets served by worker)"]
    WebAuthn["WebAuthn + PRF\n(platform + security keys)"]
    CryptoClient["X25519 + XChaCha20-Poly1305\n(client-side decrypt)"]
  end

  block:CloudflareEdge:3
    direction TB
    Worker["Single Rust Worker\n(wasm32-unknown-unknown)"]
    block:EntryPoints
      direction LR
      Fetch["#[event(fetch)]"]
      Email["#[event(email)]"]
      Cron["#[event(scheduled)]"]
    end
    Assets["ASSETS binding\n(SPA fallback)"]
  end

  block:Storage:3
    direction TB
    RegistryDO["RegistryDO\n(singleton, SQLite)"]
    MailboxDO["MailboxDO\n(one per user_id, SQLite)"]
    R2["R2 bucket\n(cfemail-blobs)"]
    KV["KV (CONFIG)\n(reserved)"]
  end

  block:External:3
    direction TB
    SMTPIn["Inbound SMTP\n(Cloudflare Email Routing)"]
    SMTPOut["Outbound SMTP\n(Email Sending binding)"]
    User["Human (passkey + paper)"]
  end

  %% Edges (logical)
  SPA -->|fetch /api/*\n(credentials:include)| Worker
  WebAuthn -->|PRF output| CryptoClient
  CryptoClient -->|unwrap X25519 priv| SPA
  Worker -->|serve static| SPA

  Fetch -->|router| EntryPoints
  Email -->|email_in| Worker
  Cron -->|backup + purge| Worker

  Worker -->|SQLite| RegistryDO
  Worker -->|SQLite| MailboxDO
  Worker -->|opaque ciphertext| R2

  SMTPIn -->|raw MIME| Email
  Worker -->|send via binding| SMTPOut
  User -->|touch ID / YubiKey| WebAuthn
```

**Key insight**: There is **one binary**, one Worker, two Durable Object classes, and one R2 bucket. The "server" never sees the user's X25519 private key.

## 2. Storage Tiers & Ownership

| Tier          | Cardinality       | Backing     | What lives here (ciphertext where noted) | Who can read plaintext? |
|---------------|-------------------|-------------|------------------------------------------|-------------------------|
| **RegistryDO** | 1 instance (`"registry"`) | SQLite (DO) | users, WebAuthn credentials, `key_wraps`, addresses, sessions, invites, challenges, secret_links | Worker only (never user content) |
| **MailboxDO**  | 1 per `user_id`   | SQLite (DO) | threads, messages (`subject_ct`, `body_ct`, `snippet_ct` are BLOBs), drafts, labels, attachment metadata | Only the owning user's session after unwrap |
| **R2**         | Global            | Object store | `raw/{uid}/...`, `attach/{uid}/...`, `backups/...`, `secret/{uid}/...` (all sealed) | Nobody (opaque to worker) |
| **KV (CONFIG)**| Global            | KV          | Reserved (currently unused)              | — |

**INVARIANT**: Every row that contains user message content in a MailboxDO **must** be stored as ciphertext. The only cleartext columns are routing metadata required for threading and display (`from_addr`, `to_addrs`, `sent_at`, `message_id`, etc.).

## 3. Cryptographic Root of Trust

Each user has **exactly one** X25519 keypair (generated in the browser at enrollment).

The private key is **never** on the server in the clear. It exists in three places only:

1. **In the user's memory / browser tab** (after successful PRF unwrap or recovery).
2. **Wrapped (AES-GCM) on the server** in `key_wraps`:
   - One row per passkey (`kind='passkey'`) — wrap key derived from WebAuthn PRF output via HKDF.
   - Exactly one recovery row (`kind='recovery'`) — wrap key derived via Argon2id(BIP39 entropy, salt).
3. **On paper** — the 12-word recovery phrase (shown once, never sent to server).

**Sealing inbound mail** (the only time the worker uses the public key):
- Worker derives ephemeral X25519 keypair.
- ECDH → HKDF-SHA256 (info = `cfemail/sealed-box/v1`) → 32-byte XChaCha20-Poly1305 key.
- Nonce = first 24 bytes of SHA-512(eph_pub || recipient_pub).
- Wire format: `eph_pub(32) ‖ nonce(24) ‖ ct+tag`.

Client `openSealedBox` performs the symmetric operation using the unwrapped private key held in RAM.

## 4. Major Request Lifecycle (Block View)

```mermaid
flowchart TD
    A[Browser] -->|1. WebAuthn create/assert + PRF| B[Worker: /auth/register or /login]
    B -->|2. Verify attestation/assertion\nStore COSE pubkey + create key_wraps| C[RegistryDO]
    A -->|3. Unwrap X25519 priv locally\n(never leaves tab)| A

    D[External Sender] -->|4. SMTP to catch-all| E[Cloudflare Email Routing]
    E -->|5. ForwardableEmailMessage| F[Worker: #[event(email)]]
    F -->|6. Parse MIME, canonicalize recipients\nLookup pubkey via Registry stub| G[RegistryDO]
    G -->|7. For each owned recipient| F
    F -->|8. seal_to(pubkey, subject+body+raw+atts)| H[R2 + MailboxDO]
    H -->|9. Store ciphertext blobs + metadata row| I[User's MailboxDO]

    J[Browser (authed)] -->|10. GET /api/threads| K[Worker]
    K -->|11. mailbox_stub(user_id)| I
    I -->|12. Return rows (ciphertext BLOBs)| K
    K -->|13. Return to SPA| J
    J -->|14. openSealedBox with in-memory priv| J
```

## 5. Durable Object Isolation Model

- **RegistryDO** is the "global directory". All workers talk to the same instance via `env.durable_object("REGISTRY").id_from_name("registry")`.
- **MailboxDO** instances are named by `user_id` (a KSUID-like string). The worker code **never** lets a request reach a MailboxDO belonging to another user — the `user_id` always comes from the authenticated session or from an address ownership lookup performed inside `email_in`.

**For Agents**:
- When you see `mailbox_stub(env, &s.user_id)`, that is the authorization boundary.
- Never construct a stub from a user-supplied `user_id` in a request body without first verifying ownership via the Registry.

## 6. Deployment & Build Boundaries

- Single `wrangler deploy` builds:
  1. `npm --prefix web run build` → `web/dist`
  2. `bash scripts/build-worker.sh` (pinned `worker-build` + post-patch for `email` handler)
- The resulting `worker/build/worker/shim.mjs` + `web/dist` are uploaded together.
- The `ASSETS` binding serves the SPA with "single-page-application" not-found handling.

## 7. Trust Boundaries (What the Worker Can Never Do)

- Decrypt any user's mail without that user's current passkey + PRF (or recovery phrase).
- Perform server-side search.
- Prevent a user who has both a passkey and the recovery phrase from accessing their data (by design).

The only plaintext the worker ever sees is:
- SMTP envelope + headers at the instant of arrival (a few milliseconds).
- Routing metadata required for threading and the inbox list.

Everything else is ciphertext from the moment `seal_to` returns until the legitimate client calls `openSealedBox`.

---

## 8. Where to Find Things (Agent Quick Index)

| Concept                        | Primary File(s)                                      |
|--------------------------------|------------------------------------------------------|
| Three event entrypoints        | `worker/src/lib.rs:26`                               |
| HTTP routing table             | `worker/src/router.rs:32`                            |
| Inbound email logic            | `worker/src/email_in.rs` (the big one)               |
| Sealed-box crypto (server)     | `worker/src/crypto.rs:17` (`seal_to`)                |
| Registry DO schema & methods   | `worker/src/registry.rs:1705` (SCHEMA)               |
| Mailbox DO schema              | `worker/src/mailbox.rs:1177`                         |
| Client crypto (noble)          | `web/src/lib/crypto.ts`                              |
| WebAuthn ceremonies (client)   | `web/src/lib/webauthn.ts`                            |
| Session cookie handling        | `worker/src/session.rs`                              |
| Build pinning + shim patch     | `scripts/build-worker.sh`                            |

Next: read [worker.md](./worker.md) for the Rust side or [web.md](./web.md) for the frontend.

*This document is intentionally diagram-heavy and light on code. The per-component docs contain the line-number-level detail.*
