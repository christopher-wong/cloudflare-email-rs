# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`cfemail` (display name **bmail**) is a server-blind email web app on Cloudflare. The user-facing name was rebranded but the internal worker name, R2 bucket name, and crypto domain-separation strings remain `cfemail*` for deploy compatibility — do not rename them.

Production deployment: `mail.middleseat.vc` serves the SPA + API for email apex `middleseat.vc`. Both are configurable via `wrangler.jsonc` vars (`APP_HOST`, `PRIMARY_DOMAIN`, `ADDITIONAL_DOMAINS`).

## Common commands

```
make install          # node deps + rust wasm target + worker-build
make build            # web (Vite) + worker (Rust→wasm)
make dev              # wrangler dev (worker + assets) on :8787
make deploy           # build + wrangler deploy
make check            # cargo check (wasm target) + tsc
make test             # worker (native cargo test) + web (vitest)
make test-worker      # cargo test --lib --manifest-path worker/Cargo.toml
make test-web         # npm --prefix web run test  (vitest, happy-dom)
make openapi          # regenerate openapi.json from #[utoipa::path] in openapi-gen/
```

Single test invocations:

```
cargo test --lib --manifest-path worker/Cargo.toml <test_name_substring>
npm --prefix web run test -- <path/to/file.test.ts> -t "<test name>"
```

Fast frontend loop: `npm run dev` (worker on :8787) in one terminal, `cd web && npm run dev` (Vite HMR on :5173, proxies `/api/*` to :8787) in another. Set `APP_HOST=localhost` in `.dev.vars` or WebAuthn fails with `RP ID mismatch`.

Always run wrangler from the project root — the `[build]` command in `wrangler.jsonc` runs in the cwd that invoked wrangler. `make dev` and `npm run dev` handle this.

## Architecture

Single Rust Cloudflare Worker serves both the API and the SPA assets (via the `ASSETS` binding). Two entrypoints in `worker/src/lib.rs`:

- `#[event(fetch)]` → `router::handle` → `api::*` handlers.
- `#[event(email)]` → `email_in::handle` (inbound MIME parse + seal-to-pubkey + store).
- `#[event(scheduled)]` → `backup::run` (daily DO→R2 snapshot at 03:17 UTC).

### Storage tiers

- **RegistryDO** (singleton keyed `"registry"`, SQLite-backed): users, WebAuthn credentials, address→user mappings, invites, server sessions, short-lived challenges, `key_wraps` (one passkey wrap per device + one mandatory recovery wrap).
- **MailboxDO** (one instance per user, SQLite-backed): threads, messages, drafts, labels, attachment metadata. Subject / body / snippet / attachment filenames stored ciphertext-only.
- **R2** (`cfemail-blobs`): opaque ciphertext blobs. Keys `attach/{user_id}/{uuid}`, `raw/{user_id}/{uuid}`, `backups/<iso8601>.json`.
- **KV** (`CONFIG`): reserved, currently unused.

Backups are JSON dumps of every DO's SQLite tables — they do NOT include R2 blobs (those survive worker deletion because R2 is separate). Admin endpoints: `POST /api/admin/backup`, `GET /api/admin/backups`, `POST /api/admin/restore`.

### Crypto model

Each user has one X25519 keypair generated in-browser at enrollment. The X25519 private key is wrapped with AES-GCM into `key_wraps` rows:

- **Passkey wraps** (1+): wrap key = `HKDF(WebAuthn PRF output)`. Requires the PRF extension — no fallback.
- **Recovery wrap** (exactly one, mandatory): wrap key = `Argon2id(BIP39 phrase, salt, m=64MiB, t=3, p=4)`. Server never sees the phrase.

Inbound mail: worker derives ephemeral X25519 key, ECDH with user pubkey, HKDF-SHA256 → XChaCha20-Poly1305 sealed box. See `worker/src/crypto.rs::seal_to`. The matching client decrypt lives in `web/src/lib/crypto.ts`.

Recovery login is a two-step proof exchange (`/api/auth/recovery/begin` then `/verify`) so possession of the wrap blob alone isn't enough — you also need the Argon2id-protected passphrase to forge the proof.

**Not protected**: From/To/Date/Message-ID (cleartext for routing/threading), in-transit SMTP (plaintext at Cloudflare's MX for the few ms before sealing), server-side search (impossible by design — search is client-side).

### Address model

Multiple addresses per user. Plus-addressing canonicalized via `config::canonical_address()` (`christopher+anything@` → `christopher@`) before any lookup. When adding domain-aware logic, use `cfg.primary_domain` for address ownership and `cfg.app_host` for WebAuthn / cookies / origins.

## Detailed Technical Documentation (Humans + Agents)

The repository now ships living technical documentation under `docs/` that is written to be equally useful to humans and coding agents:

- [docs/README.md](docs/README.md) — entry point + document map
- [docs/architecture.md](docs/architecture.md) — system block diagrams, storage tiers, crypto root of trust, major flows (Mermaid)
- [docs/worker.md](docs/worker.md) — full Rust worker design (three event handlers, RegistryDO vs MailboxDO, inbound email sequence, build pinning, invariants)
- [docs/web.md](docs/web.md) — frontend (client crypto, WebAuthn enrollment/login sequences, state model, realtime, page responsibilities)
- [docs/cloudflare-setup.md](docs/cloudflare-setup.md) — the complete Cloudflare configuration guide (Email Sending enable, Email Routing catch-all → Worker, R2, custom domains, the dashboard-only catch-all rule, local dev overrides, verification, and all the historical gotchas)

**When you are about to edit code**, read the relevant diagram in `docs/architecture.md` first, then the line-number pointers in `worker.md` or `web.md`. For anything involving production deployment, Email Routing, or Email Sending, also read `docs/cloudflare-setup.md`. These docs are the single source of truth for call order, authorization boundaries, and Cloudflare resource configuration.

**For Agents (new in 2026 docs effort)**:
- Every major flow now has an embedded Mermaid sequence diagram — use it to validate your mental model before writing or refactoring.
- "For Agents" and "**INVARIANT**" callouts in the docs are non-negotiable rules.
- When you add a new route, new crypto primitive, or change a DO schema, you are expected to update the corresponding diagram + the "touch points" table in the doc.
- The old "Project layout pointers" list below is now secondary — prefer the docs/ versions because they contain the diagrams.

## Cloudflare Workers / Rust gotchas

**This is wasm32-unknown-unknown, not tokio.** workers-rs bridges async via `wasm-bindgen-futures`. Do not use `tokio::spawn`, `tokio::time::sleep`, `tokio::sync::Mutex` — they don't compile to wasm. Use `worker::Delay` for timers, `worker::*` async helpers, and RustCrypto crates (with `default-features = false` and `getrandom` `js` feature where needed).

Durable Object trait signature is `fetch(&self, ...)` — not `&mut self`. Use interior mutability or re-run idempotent setup. Storage API exposes `SqlStorage` with typed `cursor.to_array::<T>()` deserialization.

**Worker build is pinned to a workers-rs git rev** (`3d0903a…` — the merge commit of cloudflare/workers-rs#715). Reason: the published v0.8.3 predates the `#[event(email)]` handler and v1.0.0 was yanked. `scripts/build-worker.sh`:

1. Installs `worker-build` from that same rev (the released worker-build doesn't wrap `email` correctly — bare prototype assignment loses `env`/`ctx`).
2. Filters spurious cargo errors from the workers-rs checkout's template `.toml` files.
3. Patches the generated JS shim post-build to wrap `email` the way `fetch` is wrapped.

When a non-yanked `worker > 0.8.3` containing #715 ships, drop the pin, drop the awk filter, and drop the shim patch.

**WebAuthn verifier** accepts only `"none"` attestation. Fine for modern platform authenticators and most security keys.

### serde + bytes (we keep hitting this)

The error **`invalid type: byte array, expected <something>`** has shown up at least three times in this codebase:

1. CBOR attestation parse (ciborium 0.2 mishandles authData byte-string → fixed in `webauthn/reg.rs::parse_attestation_object` with manual `Value::Map` walk).
2. SQL row deserialization into structs whose `Vec<u8>` fields weren't tagged.
3. `dump_table` on a table with a BLOB column (backup endpoint 500).

Root cause is always the same: serde's default `Vec<u8>` deserialization uses `visit_seq` (one number at a time), but the upstream serializer (workers-rs SQL cursor, ciborium, etc.) delivers bytes via `visit_bytes`. `serde_json::Value` and a stock `Vec<u8>` field have no `visit_bytes` impl, so the deserializer fails.

**Defensive rules:**

- Any struct field that holds a SQLite BLOB column **must** be `#[serde(with = "serde_bytes")] pub_key: Vec<u8>`. Plain `Vec<u8>` will fail at runtime, not compile time.
- In `worker/src/backup.rs`, **prefer `dump_blob_table` over `dump_table` by default**. `dump_table` only works for tables guaranteed to be text/int forever. When adding or modifying a `dump_table` call, grep the matching `CREATE TABLE` for `BLOB` first.
- The export and import sides of a backup must agree on the blob-column list — if you add a BLOB column, update **both** `dump_blob_table` and `load_table` arg lists in the same change.
- For CBOR / ad-hoc binary formats, don't `#[derive(Deserialize)]` a struct with byte fields against ciborium. Walk the `ciborium::Value` tree by hand.

## Local dev caveats

- DO state lives in `.wrangler/state/` and is local-only. Delete that directory for a factory reset. Locally-enrolled passkeys do not migrate to prod.
- Outbound `env.EMAIL.send()` is logged to stdout by miniflare. To send real mail from local, set `"remote": true` on the `send_email` binding in `wrangler.jsonc`.
- Inbound `email()` cannot be tested locally — Cloudflare Email Routing won't deliver to a localhost worker. Deploy to a `*.workers.dev` preview to exercise that path.
- First wasm build is 2-3 min (`worker-build` + `wasm-opt`); incremental ~30s.

## Project layout pointers

- `worker/src/lib.rs` — fetch / email / scheduled entrypoints
- `worker/src/router.rs` — HTTP dispatch
- `worker/src/api/` — route handlers (auth, me, mail, drafts, labels, attachments, admin, misc)
- `worker/src/registry.rs`, `worker/src/mailbox.rs` — the two DO impls
- `worker/src/webauthn/` — COSE parsing + attestation + assertion verification
- `worker/src/email_in.rs` — inbound MIME → sealed ciphertext
- `worker/src/backup.rs` — DO → R2 snapshot/restore
- `worker/src/config.rs` — env vars, domain helpers, plus-address canonicalization
- `openapi-gen/` — native (non-wasm) binary that emits `openapi.json` from `#[utoipa::path]` annotations
- `web/src/lib/{api,crypto,webauthn,store}.ts` — frontend wiring

**Strongly prefer the living documentation in `docs/` (architecture.md, worker.md, web.md)** over the bullet list above when you need to understand flows or call order. The docs contain up-to-date Mermaid diagrams and "For Agents" guidance that were written during the 2026 documentation pass. Update them when you change architecture.
