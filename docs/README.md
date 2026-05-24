# bmail / cfemail — Technical Documentation

This directory contains detailed, agent-friendly documentation for the **bmail** (internal name `cfemail`) server-blind encrypted email application.

## Audience

- **Humans** — architects, new contributors, operators, security reviewers.
- **Coding agents / LLMs** — precise invariants, file pointers (`worker/src/foo.rs:123`), sequence diagrams, "what to touch" guidance.

## Document Map

| Document | Purpose | Key Diagrams |
|----------|---------|--------------|
| [architecture.md](./architecture.md) | System overview, storage tiers, crypto model, high-level data flows | Component block diagram, request lifecycle |
| [worker.md](./worker.md) | Rust Cloudflare Worker deep dive (entrypoints, Durable Objects, inbound email, crypto, build) | `#[event(fetch)]` / `email()` / `scheduled` flows, RegistryDO vs MailboxDO |
| [web.md](./web.md) | React + Vite frontend (WebAuthn, client crypto, state, realtime) | Enrollment sequence, login + unwrap, message decrypt render |
| [cloudflare-setup.md](./cloudflare-setup.md) | Exact Cloudflare resources needed (Email Sending + Routing catch-all, R2, custom domains, cron, vars) + dashboard vs CLI steps and gotchas | Email configuration flow diagram |
| CLAUDE.md (root) | Agent instructions + gotchas (updated with references to these docs) | — |

## Quick Mental Model (read this first)

```
Browser (SPA) 
   ↕ WebAuthn PRF + X25519 sealed boxes (client decrypt)
Cloudflare Worker (Rust, single binary)
   ├── fetch → router → api/* (auth, mail, admin, secret-links)
   ├── email → email_in (parse MIME → seal to user pubkey → store)
   └── scheduled → daily backup + purge
Storage
   ├── RegistryDO (singleton) — users, credentials, key_wraps, addresses, sessions
   ├── MailboxDO (one per user) — threads, messages (ciphertext), drafts, labels
   └── R2 (cfemail-blobs) — raw ciphertext, attachments, backups
```

Everything after the initial SMTP plaintext moment is **end-to-end encrypted at rest** from the perspective of the storage layer. The worker only ever holds the user's **public** X25519 key for sealing inbound mail.

## How to Use These Docs as a Coding Agent

1. Start with `architecture.md` for the invariant picture.
2. Jump to `worker.md` or `web.md` when you see a path like `worker/src/email_in.rs` or `web/src/lib/webauthn.ts`.
3. Every major flow has a Mermaid sequence diagram — use it to understand call order before editing.
4. Look for **"Invariants"** and **"For Agents"** callout boxes — these are the rules that must not be broken.
5. When adding features, update the relevant diagram + the "touch points" table in the doc.

## Related Files (always keep in sync)

- `README.md` (user-facing)
- `CLAUDE.md` (this repo's agent bible — has been updated with pointers to `docs/`)
- `wrangler.jsonc` (bindings, vars, cron)
- `worker/src/lib.rs` (three `#[event(...)]` entrypoints)
- `web/src/lib/{crypto,webauthn,api}.ts`

## Conventions Used in These Docs

- File paths are written as `worker/src/foo.rs:42` (clickable in most editors).
- Mermaid diagrams are embedded with language `mermaid`.
- "Agent notes" appear in `> **For Agents**` blockquotes.
- Invariants that must be preserved are marked with `**INVARIANT**`.

---

*Generated as part of the 2026 documentation effort. Keep these docs living — they are the single source of truth for both humans and future agents.*
