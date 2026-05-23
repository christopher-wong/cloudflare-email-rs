# bmail

A minimalist, server-blind email web app on Cloudflare. Passkey auth with
the WebAuthn **PRF extension**, X25519 sealed-box at-rest encryption,
multi-user with per-user mailbox isolation via Durable Objects, plus-addressing,
and a flat black-and-white UI.

Open source, self-hostable, configurable for any domain.

> The internal worker name, R2 bucket name, and a handful of crypto
> domain-separation strings remain `cfemail*` for compatibility with
> existing deployments — they're not user-visible. Rebranding only
> touches display strings, the `APP_NAME` env var, and docs.

## What's in the box

| Tier         | What                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **Frontend** | React + Vite + TypeScript + Tailwind. WebAuthn PRF, X25519 + XChaCha20-Poly1305 client decrypt.   |
| **Worker**   | Rust (`workers-rs` 1.0). One `fetch` handler for the API + assets, one `email` handler inbound.   |
| **Storage**  | Durable Objects (SQLite-backed) for the user directory and each user's mailbox. R2 for ciphertext blobs. KV reserved for future config. |
| **Email**    | Cloudflare Email Routing (inbound) + Email Sending binding (outbound).                            |

## Architecture

```
                       ┌────────────────────────────────────────┐
                       │  Frontend (Vite SPA)                   │
                       │  WebAuthn PRF → HKDF → AES-GCM wrap    │
                       │  X25519 + XChaCha20-Poly1305 decrypt   │
                       └────────────────────┬───────────────────┘
                                            │ fetch /api/*
                       ┌────────────────────▼───────────────────┐
                       │  Worker (Rust)                         │
                       │  router → api::*                       │
                       │  email() → email_in (parse + encrypt)  │
                       │  EMAIL binding → outbound SMTP         │
                       └──┬──────────────┬────────────┬─────────┘
              ┌───────────┘              │            └────────────┐
              │                          │                         │
        ┌─────▼──────────┐    ┌──────────▼──────────┐      ┌───────▼───────┐
        │ RegistryDO     │    │ MailboxDO (per user)│      │ R2 bucket     │
        │  users         │    │  threads, messages, │      │  raw .eml ct  │
        │  credentials   │    │  drafts, labels,    │      │  attachments  │
        │  addresses     │    │  attachments meta   │      │  (all ct)     │
        │  invites       │    │  (subject/body/snip │      │               │
        │  sessions      │    │   stored ciphertext)│      │               │
        │  challenges    │    │                     │      │               │
        └────────────────┘    └─────────────────────┘      └───────────────┘
```

### Storage model

- **RegistryDO** — single instance keyed `"registry"`. Holds the directory:
  users, WebAuthn credentials, address→user mappings, invites, server
  sessions, short-lived WebAuthn challenges.
- **MailboxDO** — one instance per user, keyed by user id. Holds threads,
  messages, drafts, labels, attachment metadata. Subject, body, snippet,
  and attachment filenames are stored ciphertext-only.
- **R2** — opaque ciphertext blobs (raw inbound MIME, attachment bytes).
  Keys are `attach/{user_id}/{uuid}` and `raw/{user_id}/{uuid}`.

### Encryption model — honestly

- Each user has **one X25519 keypair** generated in-browser at enrollment.
- The **private key is wrapped** with AES-GCM and stored on the server in
  one-or-more rows in `key_wraps`:
  - **Passkey wraps** (one per device) — wrap key is `HKDF(WebAuthn PRF output)`.
  - **Recovery wrap** (exactly one, mandatory) — wrap key is
    `Argon2id(BIP39 phrase, salt, m=64MiB, t=3, p=4)`.
  All wraps protect the same underlying X25519 private key, so the user
  can unwrap from any one path.
- Adding a second passkey is **optional**: from Settings → Passkeys. The
  current device holds the unwrapped priv in memory, so it just wraps the
  same key with the new passkey's PRF-derived key and uploads the new wrap.
- The **recovery phrase is mandatory** at enrollment. It's shown once on
  screen. The server never receives it. Lose your passkey + lose the
  phrase = locked out forever (by design).
- On every inbound email, the worker derives a fresh ephemeral X25519 key,
  computes ECDH with the user's pubkey, derives an XChaCha20-Poly1305 key
  via HKDF-SHA256, and stores the sealed-box ciphertext.
- On display, the browser holds the unwrapped private key in memory only
  for the session and decrypts each blob on the fly.

**Recovery login flow** (two-step to bound brute-force surface):

1. `POST /api/auth/recovery/begin { handle }` → server returns the recovery
   wrap (kdf params + wrapped blob) + a random proof token sealed to the
   user's X25519 pubkey.
2. Client derives the wrap key from the phrase + Argon2id (slow), unwraps
   the private key, decrypts the sealed proof.
3. `POST /api/auth/recovery/verify { proof }` → server checks the proof
   matches the one it issued, then issues a session cookie.

Possession of the wrap blob alone is not enough — you also need the
Argon2id-protected passphrase to forge a valid proof.

**What this gets you**: at-rest encryption where the storage tier (DOs +
R2) is server-blind. Cloudflare cannot decrypt your subjects, bodies, or
attachments without access to your authenticator and the device's PRF
secret.

**What this does NOT get you**:

1. **In-transit E2E.** Email arrives at Cloudflare's MX servers in
   plaintext over SMTP — that traffic isn't encrypted to you. The worker
   sees plaintext for the few ms it takes to seal the message. True E2E
   would require PGP/S-MIME at both ends.
2. **Server-side search.** With encrypted bodies/subjects, the worker
   can't grep. Search becomes client-side over data you've already loaded.
3. **Metadata privacy.** From, to, date, message-id stay cleartext for
   routing/threading — same trade-off Proton Mail makes.

## Browser requirements

WebAuthn PRF support is required (no fallback in v1):

| Browser     | Minimum             |
| ----------- | ------------------- |
| Chrome/Edge | 116                 |
| Safari      | 17.4                |
| Firefox     | 122                 |

Plus an authenticator that supports PRF — modern platform authenticators
(Touch ID, Windows Hello, Android biometrics) and recent FIDO2 keys
(YubiKey 5+) all work.

## Backup and restore

Durable Objects don't have built-in snapshots (unlike D1's Time Travel),
so this app ships its own backup mechanism: every DO can dump its
SQLite tables as JSON, and a worker endpoint packages those dumps into
a single bundle stored in the R2 bucket.

**Automatic.** A cron trigger (`triggers.crons` in `wrangler.jsonc`)
fires `#[event(scheduled)]` once a day at 03:17 UTC and runs the same
backup logic. Output lands in the R2 bucket at
`backups/<iso8601>.json`.

**Manual.** Admin-only HTTP endpoints:

```bash
# create a snapshot now; returns {"key": "backups/...", "size_bytes": N}
curl -X POST https://mail.middleseat.vc/api/admin/backup \
  -b "cfemail.session=<your-admin-session-cookie>"

# list available snapshots, newest first
curl https://mail.middleseat.vc/api/admin/backups \
  -b "cfemail.session=<your-admin-session-cookie>"

# restore — overwrites in-place via INSERT OR REPLACE
curl -X POST https://mail.middleseat.vc/api/admin/restore \
  -H 'content-type: application/json' \
  -b "cfemail.session=<your-admin-session-cookie>" \
  -d '{"key": "backups/2026-05-23T03-17-00Z.json"}'
```

**Retention.** Old snapshots aren't auto-deleted by the worker. Set
an R2 lifecycle rule on `cfemail-blobs` (or whatever your bucket is
named) with prefix `backups/` and an "expire after N days" rule —
14 days is a reasonable default.

**What's *not* in the bundle:** R2 blobs themselves (attachments, raw
.eml ciphertext). They're stored under separate prefixes
(`attach/`, `raw/`) and survive worker deletion because R2 is a
separate Cloudflare resource. Only DO metadata is at risk and only
DO metadata is in the bundle.

## First-time setup

### 1. Toolchain

```
make install
```

Installs Node deps, adds the `wasm32-unknown-unknown` target, and
installs `worker-build`.

### 2. Configure your domain

Edit `wrangler.jsonc`:

```jsonc
"vars": {
  "PRIMARY_DOMAIN":      "yourdomain.com",   // email apex
  "ADDITIONAL_DOMAINS":  "",                 // comma-separated, optional
  "APP_HOST":            "mail.yourdomain.com",  // SPA host = WebAuthn RP ID
  "APP_NAME":            "yourdomain mail",
  "SESSION_TTL_DAYS":    "30"
}
```

Defaults are wired for `middleseat.vc` / `mail.middleseat.vc`.

### 3. Create the Cloudflare resources

```bash
npx wrangler kv namespace create CONFIG
npx wrangler r2 bucket create cfemail-blobs
```

Paste the returned IDs into `wrangler.jsonc`. The Durable Object bindings
are declared in `wrangler.jsonc` and the `migrations` block creates them
on first deploy.

### 4. Enable Email Service on the domain

**Outbound (Email Sending)** — adds SPF/DKIM DNS records on your zone:

```bash
npx wrangler email sending enable yourdomain.com
```

**Inbound (Email Routing)** — enable routing, then point the catch-all
at the worker. **The catch-all must be set in the Cloudflare dashboard,
not via wrangler** (see the note below).

```bash
# Provisions MX records on yourdomain.com.
npx wrangler email routing enable yourdomain.com
```

Now open
`https://dash.cloudflare.com/?to=/:account/yourdomain.com/email`
→ **Email Routing** → **Routing rules** → **Catch-all address** →
**Edit**, then:

- Action: **Send to a Worker**
- Worker: `cfemail`
- Save, and make sure the catch-all is **enabled**

(The worker must already be deployed for the dashboard to offer `cfemail`
as a target. On a fresh install, run step 5 first, then come back here.)

> **Why the dashboard?** The wrangler CLI today refuses to set a catch-all
> rule with a worker action (`Catch-all rule only supports 'forward' or
> 'drop' action types`), and `rules create --match-type all` is rejected
> by the API because the CLI insists on sending match-field/match-value.
> The dashboard and the raw REST API both accept `catch-all → worker`
> fine — it's a CLI gap, tracked upstream. Once `wrangler` ships the fix,
> this step collapses back to a one-line `rules update … --action-type
> worker --action-value cfemail`.

### 5. Deploy

```
make deploy
```

Builds the SPA, builds the Rust worker, runs `wrangler deploy`. The
worker hosts both the API and the static frontend (`ASSETS` binding at
`web/dist`).

### 6. Bootstrap your first user

Open `https://mail.yourdomain.com`. The frontend detects the empty
registry, redirects to `/bootstrap`, you claim your address (e.g.
`christopher`) and handle, submitting mints a one-time invite token and
sends you to `/enroll?token=…` where you'll register your passkey.

From then on: sign in at `/login`, create invites for additional users
via the **admin** tab.

## Development

The short version: **`wrangler dev` runs the worker on your machine with a
local emulator for every binding**, and the frontend either gets served by
that worker or runs separately on `vite dev` proxying to it. You don't need
to deploy to test anything except real inbound email.

### What runs where in `wrangler dev`

```
                 ┌──────────────────────────────────────┐
                 │  npm run dev    (wrangler dev)       │
                 │  ─────────────────                   │
                 │  ↓ workerd (Cloudflare's open-source │
                 │    runtime, same engine as prod)     │
                 │  ↓ miniflare (emulates the bindings) │
                 │                                      │
                 │   • Worker code  → your Rust .wasm   │
                 │   • DOs          → SQLite at         │
                 │                    .wrangler/state/  │
                 │   • R2           → ./.wrangler/...   │
                 │   • KV           → ./.wrangler/...   │
                 │   • send_email   → logged to console │
                 │   • email() in   → simulated via CLI │
                 │   • Assets       → from web/dist     │
                 │                                      │
                 │  Listens on http://127.0.0.1:8787    │
                 └──────────────────────────────────────┘
```

Everything is **local** by default — DOs, R2, KV, sessions all persist to
`.wrangler/state/` in the repo. Deleting that directory is your "factory
reset" — useful when you've created a few test users you want to wipe.

### Two ways to develop the frontend

**Mode A (closest to prod) — worker serves everything**

```bash
make build && npm run dev
```

Vite builds `web/dist` once; `wrangler dev` serves that via the `ASSETS`
binding plus the API on the same origin. Same shape as production, no
CORS, no proxy. Slow loop because you `make build` whenever you change
React code.

**Mode B (fast frontend loop) — Vite + Wrangler in parallel**

```bash
# terminal 1
npm run dev               # API on :8787

# terminal 2
cd web && npm run dev     # SPA on :5173 with HMR
```

`vite.config.ts` proxies `/api/*` to `127.0.0.1:8787`, so the SPA acts
like it's same-origin. React HMR works, but cookies need
`credentials: 'include'` (already set in `lib/api.ts`).

### What works locally vs. needs the cloud

| Capability                  | Local?     | Notes                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| All API routes              | ✅          | full miniflare emulator                                                                                                                                                                                                                                                                                                                     |
| Durable Objects + SQLite    | ✅          | persistent in `.wrangler/state/`                                                                                                                                                                                                                                                                                                            |
| R2 puts/gets                | ✅          | local filesystem                                                                                                                                                                                                                                                                                                                            |
| KV                          | ✅          | local                                                                                                                                                                                                                                                                                                                                       |
| Outbound `send_email`       | ⚠️ partial | By default, miniflare *logs* the email to the console (subject, body, etc.). To actually send real mail in dev, add `"remote": true` to the `send_email` binding in `wrangler.jsonc` — `wrangler dev` then proxies that one binding to the real Email Service while everything else stays local. Real emails go to real recipients — use a test address you control. |
| Inbound `email()` handler   | ❌          | Cloudflare doesn't deliver inbound to a local worker. To exercise the inbound path, **deploy to a `*.workers.dev` preview** and send a real email to your routed address.                                                                                                                                                                   |
| WebAuthn                    | ⚠️          | Works on `localhost` for Chrome / Edge / Firefox / Safari (the spec lets `localhost` skip HTTPS). Touch ID + platform authenticators work. But the RP ID must match the host you're using — set `APP_HOST=localhost` in `.dev.vars` when developing locally, otherwise the browser refuses with `SecurityError: RP ID mismatch`.            |
| Email Routing DNS           | n/a        | Only matters for prod.                                                                                                                                                                                                                                                                                                                       |

### Suggested local config

Add a `.dev.vars` next to `wrangler.jsonc` (it's already gitignored):

```
PRIMARY_DOMAIN=localhost
APP_HOST=localhost
ADDITIONAL_DOMAINS=
```

With these:

- bootstrap creates `christopher@localhost`
- passkey RP ID = `localhost` (works in all browsers without TLS)
- outbound `env.EMAIL.send()` is captured to stdout — copy/paste the
  simulated message to verify content

When you want to test **outbound for real** from local, flip:

```jsonc
"send_email": [{ "name": "EMAIL", "remote": true }]
```

Now `env.EMAIL.send()` hits the real Cloudflare Email API and actually
delivers, even though your code runs on localhost. Use a test recipient
you control — these are real emails.

When you want to test **inbound** the only honest way is to deploy a
preview and send mail to a routed address on your domain.

### Suggested loop

```bash
make install              # one-time
make build                # one-time, before first dev
npm run dev               # leave running

# in another terminal:
cd web && npm run dev     # hot-reloading frontend on :5173
```

Open `http://localhost:5173`, register a passkey on the bootstrap page,
write down the recovery phrase, send yourself a test message — the
outbound stub will print it to the wrangler terminal. Iterate. Push a
preview deploy when you want to validate the inbound path.

### Gotchas worth knowing up front

- **DO state is local-only.** Deploying does not migrate `.wrangler/state/`
  to prod. So your locally-enrolled passkeys don't follow you to prod.
  You'll bootstrap once in prod separately. That's by design — the data
  is encrypted to your prod passkey anyway.
- **PRF needs `localhost` in `.dev.vars`.** If `APP_HOST` is set to your
  prod host (`mail.middleseat.vc`) while you're running on `localhost`,
  WebAuthn registration will fail with `SecurityError`.
- **The first build is slow.** `worker-build` compiles Rust + runs
  `wasm-opt`. Expect 2-3 minutes the first time, ~30s on incremental
  rebuilds.
- **Run dev from the project root.** Wrangler's `[build]` runs the
  custom build command in the cwd you invoked from, so `npx wrangler dev`
  fired from a subdirectory will fail with `npm error Missing script:
  "web:build"`. Use `npm run dev` or `make dev` — both `cd` to the
  project root automatically.
- **Inbound testing requires deploy.** No way around it. Email Routing
  rules can't target a localhost worker.

### Continuous deployment

`.github/workflows/ci.yml` runs on every push and pull request: `tsc`,
`cargo check --target wasm32-unknown-unknown`, `cargo test`, and
`vitest`. On a green build *on master* (not PR branches), it then runs
`wrangler deploy`, which performs the full wasm + Vite build via the
project's `wrangler.jsonc` `build.command`.

Required repository secrets (Settings → Secrets and variables →
Actions):

- `CLOUDFLARE_API_TOKEN` — a token with these permissions on the
  account that owns the worker: `Workers Scripts:Edit`,
  `Account Settings:Read`, `D1:Edit` (unused but the template asks),
  `Workers R2 Storage:Edit`, `Workers KV Storage:Edit`,
  `Email Routing Addresses:Edit`.
- `CLOUDFLARE_ACCOUNT_ID` — visible in the Cloudflare dashboard
  sidebar.

The deploy job is single-concurrent on master so two pushes never race
to a write a Durable Object. PR check jobs cancel on superseding push.

## Project layout

```
cfemail/
├── Cargo.toml                 # workspace
├── Makefile                   # install / build / dev / deploy
├── README.md
├── package.json               # root (wraps wrangler + web build)
├── wrangler.jsonc             # worker + bindings config
├── worker/                    # Rust worker
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs             # entrypoints: fetch + email
│       ├── router.rs          # HTTP dispatch
│       ├── error.rs
│       ├── b64.rs
│       ├── config.rs          # vars, domain helpers, plus-addressing
│       ├── crypto.rs          # seal_to (NaCl-style sealed box)
│       ├── session.rs
│       ├── webauthn/          # ceremony verifier
│       │   ├── mod.rs
│       │   ├── cose.rs        # COSE_Key parser
│       │   ├── reg.rs         # attestation verify
│       │   └── auth.rs        # assertion verify
│       ├── registry.rs        # RegistryDO
│       ├── mailbox.rs         # MailboxDO
│       ├── email_in.rs        # inbound email() handler
│       └── api/               # HTTP route handlers
│           ├── mod.rs
│           ├── auth.rs
│           ├── me.rs
│           ├── mail.rs
│           ├── drafts.rs
│           ├── labels.rs
│           ├── attachments.rs
│           ├── admin.rs
│           └── misc.rs
└── web/                       # Vite + React + Tailwind frontend
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── styles.css
        ├── lib/
        │   ├── api.ts
        │   ├── b64.ts
        │   ├── crypto.ts
        │   ├── webauthn.ts
        │   ├── store.ts
        │   └── time.ts
        ├── components/
        └── pages/
```

## Visual design

Two colors. No radius. No shadow. No gradient. JetBrains Mono. 1px
hairlines. Hover = invert. The goal is brutalist-tech — terminal-coded
but soft on the eyes. See `web/src/styles.css` for tokens.

## Status

This is a first cut. Working end-to-end:

- bootstrap + passkey enrollment + login
- inbound email → encrypted-at-rest storage
- inbox + thread view with client-side decrypt
- compose + send (plaintext SMTP out, ciphertext copy in your mailbox)
- drafts with autosave (ciphertext)
- labels CRUD
- admin: invites, user list
- multiple addresses per user, plus-addressing

Rough edges to round off in v0.2:

- attachment upload UI (backend done; frontend affordance not wired)
- search (client-side; not implemented)
- the `Sent` filter is approximate (shows all threads)
- WebAuthn verifier accepts only `"none"` attestation — fine for every
  modern platform authenticator and most security keys
- recovery: lose your passkey → lose access. Add a second passkey via
  admin or set up a recovery passphrase before that becomes urgent

## License

MIT.
