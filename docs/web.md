# Web Application (React + Vite) — Detailed Design

**Primary entry point**: `web/src/main.tsx` → `App.tsx`

## 1. High-Level Frontend Architecture

```mermaid
flowchart TD
    subgraph "Browser Tab"
        SPA[React 18 + React Router + Tailwind]
        State[AppContext + module-level sessionPriv]
        Crypto[web/src/lib/crypto.ts\n(noble/* + WebCrypto)]
        WA[web/src/lib/webauthn.ts\n(ceremonies + recovery)]
        API[web/src/lib/api.ts\n(fetch with credentials:include)]
        Realtime[web/src/lib/realtime.ts\n(WebSocket to MailboxDO)]
    end

    subgraph "Worker Origin (same as SPA)"
        WorkerAPI[/api/* endpoints/]
        WS[WebSocket /api/realtime]
    end

    SPA -->|user actions| API
    API -->|HTTP| WorkerAPI
    WA -->|navigator.credentials.create/get| BrowserWebAuthn[WebAuthn API]
    Crypto -->|deriveWrapKey / openSealedBox| State
    Realtime -->|WS upgrade + notify| WS
    State -->|holds unwrapped X25519 priv\n(window[PRIV_HANDLE])| Crypto
```

The SPA and the API are **same-origin** in production (both served from `mail.middleseat.vc` via the ASSETS binding + SPA fallback). This eliminates CORS concerns for the main app.

## 2. Cryptography on the Client (`lib/crypto.ts`)

The client is the **only** place that ever sees the plaintext X25519 private key.

Key exported functions:

| Function                        | Purpose                                      | Called from                  |
|---------------------------------|----------------------------------------------|------------------------------|
| `newX25519Keypair`              | Generate the single user keypair at enroll   | `webauthn.ts` register       |
| `deriveWrapKey(prfOutput)`      | PRF bytes → AES-GCM key (via HKDF)           | Passkey login / add          |
| `wrapPrivKey / unwrapPrivKey`   | AES-GCM around the X25519 priv               | Same                         |
| `openSealedBox(blob, priv)`     | Decrypt one inbound sealed message           | Inbox, Thread, notifications |
| `sealToSelf(plaintext, pub)`    | Encrypt draft to own pubkey (symmetric)      | Compose autosave             |
| `deriveRecoveryWrapKey(phrase, salt)` | Argon2id(entropy) → AES-GCM key        | Recovery flow                |

**Domain strings** must match the server exactly:
- `cfemail/sealed-box/v1`
- `cfemail/wrap-key/v1`

The recovery path uses the raw BIP39 **entropy** (not the mnemonic string) as the Argon2id password input. This gives canonical behavior regardless of how the user wrote the phrase down.

## 3. WebAuthn + Enrollment Flow (Sequence)

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant F as Frontend (webauthn.ts)
    participant W as Worker
    participant R as RegistryDO

    U->>F: Clicks "Enroll with invite token"
    F->>W: POST /api/auth/register/options {invite_token}
    W->>R: Redeem invite + create challenge
    W-->>F: RegisterOptions (challenge, prf_salt, rp, user, etc.)
    F->>U: navigator.credentials.create({publicKey, extensions.prf})
    U-->>F: Attestation + PRF output (first)
    F->>F: Generate X25519 keypair (priv, pub)
    F->>F: deriveWrapKey(PRF) → AES key
    F->>F: wrapPrivKey(priv, AES) → passkeyWrapped
    F->>F: generateRecoveryPhrase() + Argon2id → recoveryWrapped
    F->>W: POST /api/auth/register/verify
        {attestation, pub_key_b64, wraps: [passkey, recovery], ...}
    W->>W: Verify attestation (reg.rs)
    W->>R: /users/register + /key-wraps + create session
    R-->>W: user_id, addresses
    W-->>F: 200 + Set-Cookie (session)
    F->>U: Show recovery phrase ONCE (then zero from memory)
    F->>F: sessionStashPriv(unwrapped priv)
```

**For Agents**:
- The recovery phrase is generated **after** the passkey ceremony succeeds but **before** the verify call. If the user closes the tab at that moment they lose the phrase forever (by design — write it down).
- A second passkey (Settings → Passkeys) re-uses the *already unwrapped* in-memory private key; it only creates a new wrap row.

## 4. Login + Re-unlock After Reload

After a full page load the in-memory private key is gone.

The app does:
1. `GET /api/admin/status` (works unauthenticated) → learns if bootstrap is needed.
2. If a session cookie exists, `GET /api/me`.
3. If `me` succeeds but `sessionPriv() === null`, the UI shows a "Unlock with passkey" prompt (see `Chrome.tsx` and the various pages that call `sessionPriv()` before rendering decrypted content).
4. The unlock path performs a WebAuthn assertion (with PRF), derives the wrap key, fetches the cached wrap blob from IDB (or the server), unwraps, and calls `sessionStashPriv`.

This gives a fast "re-open tab" experience while still requiring the authenticator.

## 5. State Management (`lib/store.ts` + `AppContext`)

Very small global store:

```ts
interface AppState {
  status: StatusResp | null;   // public config + bootstrap flag
  me: User | null;             // basic profile + addresses
  loading: boolean;
}
```

The **actual X25519 private key** lives outside React state in a module-level `window` property (`__cfemail_priv_session__`). This is deliberate — it survives certain HMR / strict-mode double-mount scenarios and is easy to zero from anywhere.

`realtime.start()` / `stop()` is tied to whether `me` exists.

## 6. Realtime Notifications

- On first authenticated load, the SPA opens a WebSocket to `/api/realtime`.
- The connection is accepted by the user's `MailboxDO`.
- When `email_in` or the send path inserts a new message, it also does an internal `POST /notify` to the same DO.
- The DO broadcasts a tiny JSON object containing enough sealed metadata for the SPA to show a native notification without another round-trip.

The WebSocket uses the same session cookie (the DO can read it because the upgrade request carries cookies).

## 7. Key Pages & Responsibilities

| Page / Component          | Responsibilities                                                                 |
|---------------------------|----------------------------------------------------------------------------------|
| `Landing.tsx`             | Marketing + entry points                                                         |
| `Bootstrap.tsx` / `Enroll.tsx` | First-user flow + invite redemption + key generation                    |
| `Login.tsx`               | Normal + recovery entry                                                          |
| `Inbox.tsx` + `Thread.tsx`| List + decrypt-on-render. Heaviest users of `sessionPriv()` + `openSealed*`     |
| `Compose.tsx`             | Outbound send + self-sealed draft autosave                                       |
| `Secrets.tsx` / `Share.tsx` / `SecretView.tsx` | Password-protected external links (separate crypto)               |
| `Admin.tsx`               | Invites, users, addresses, manual backup/restore (admin-only)                    |
| `Settings.tsx`            | Add/remove passkeys, profile, (future) recovery phrase management                |

## 8. IndexedDB Cache (`lib/idb.ts`)

Only one thing is cached: the **wrapped** private key blob + the credential id + PRF salt needed to re-derive the wrap key.

This allows a reload to perform only one passkey assertion instead of a full username/password-style login.

The cache is cleared on explicit logout.

**Never** put the unwrapped private key in IDB or localStorage.

## 9. Error & Loading UX

- All API calls go through the thin `api.ts` wrapper.
- On HTTP error it throws `ApiError(status, message)`.
- Pages generally show a generic error banner; the real detail is in the console + worker logs.

## 10. Invariants for Frontend Changes

1. The only place the unwrapped X25519 private key may live is the value returned by `sessionPriv()` (the window-backed slot). Never duplicate it into React state, a global variable with another name, or any storage.
2. Every time you render a `subject_ct_b64` or `body_ct_b64` you **must** have a non-null `sessionPriv()` or show a placeholder / "locked" state.
3. Recovery phrase generation happens in the browser and is shown **exactly once**. After the verify call succeeds, the phrase bytes must be gone from all JS variables.
4. When adding a new way to obtain the private key (future hardware, passkey PRF on another device, etc.), it must still end up calling `sessionStashPriv` and clearing the old value.

## 11. For Coding Agents — Common Edit Locations

| Task                              | Files you will touch                                      |
|-----------------------------------|-----------------------------------------------------------|
| Change decrypt logic or add KDF   | `web/src/lib/crypto.ts` + matching server `crypto.rs`    |
| New WebAuthn ceremony or recovery step | `web/src/lib/webauthn.ts` + corresponding worker handler |
| New realtime message type         | `web/src/lib/realtime.ts` + `worker/src/mailbox.rs` (notify) |
| New page that shows mail          | Must import + guard on `sessionPriv()` from `webauthn`   |
| Add a secret-link feature         | `web/src/lib/secret-link.ts` + `worker/src/api/secret.rs` |

Cross-reference the sequence diagrams in [architecture.md](./architecture.md) before making changes that cross the client/worker boundary.

---

**See also**:
- [worker.md](./worker.md) — the server side that this talks to
- `web/src/lib/webauthn.test.ts` and `crypto.test.ts` for executable examples of the primitives
- The root `CLAUDE.md` for the "fast frontend loop" development instructions (`npm run dev` in one terminal + `cd web && npm run dev` in another, `APP_HOST=localhost` requirement, etc.)
