#!/usr/bin/env bash
#
# Build the Rust worker -> wasm. Wraps `worker-build` so:
#   1. its exit code is preserved (via pipefail), and
#   2. spurious cargo "errors" from the workers-rs git checkout's
#      template/*.toml placeholders are filtered out.
#
# Used by both `make worker` and `npm run worker:build`.
#
# The noise filter drops away once a non-yanked worker > 0.8.3 ships and we
# move off the git pin in worker/Cargo.toml.

set -euo pipefail

cd "$(dirname "$0")/../worker"

# Ensure the builder is available. We install from a pinned git rev rather
# than crates.io because the released v0.8.3 was cut from a parallel branch
# that did NOT include cloudflare/workers-rs#715 (EmailWorkers). Without
# that commit, worker-build emits `Entrypoint.prototype.email = exports.email`
# (bare) instead of wrapping it like fetch/queue/scheduled — so Cloudflare's
# WorkerEntrypoint invocation `worker.email(msg)` reaches our Rust handler
# with `env = undefined` and every inbound message drops as "not-owned".
# Pin to the same rev we pin the worker crate to (3d0903a) so the macro,
# the runtime, and the builder all agree.
#
# Remove this once a worker-build release ships that contains #715
# (presumably v0.8.4 or later) and switch back to `worker-build@^0.8.4`.
# The workers-rs git checkout ships template Cargo.toml files with
# cookiecutter-style placeholders ({{project-name}}, {% if %}). Cargo
# tries (and fails) to parse them as workspace members whenever it
# scans the checkout — both `cargo install` and `worker-build`'s
# inner cargo invocation emit those errors. They're harmless; this
# function eats matching error blocks (multi-line, no blank
# separator between them) while letting everything else through.
quiet_template_noise() {
  # Each cargo template-parse error is a fixed 5-line block:
  #   error: …                           ← trigger
  #    --> path:line:col                 ← line 2
  #     |                                ← line 3
  #   N | original content                ← line 4
  #     |     ^^^^                       ← line 5
  # No blank separator between adjacent error blocks, so we can't
  # rely on "skip until blank." Count is reliable because cargo's
  # output for these particular parse errors hasn't changed shape.
  awk '
    /^error: (invalid character .* in package name|missing key for inline table element|expected expression, found)/ {
      skip = 4
      next
    }
    skip > 0 { skip--; next }
    { print }
  '
}

WORKER_BUILD_REV="3d0903aac3332a69ed5393d5a6cceb9ddb2f17b4"
cargo install -q \
  --git https://github.com/cloudflare/workers-rs.git \
  --rev "$WORKER_BUILD_REV" \
  worker-build 2>&1 \
  | quiet_template_noise

# Run the build through the same filter. `pipefail` ensures we exit
# non-zero if worker-build fails even when the filter runs cleanly.
worker-build --release 2>&1 \
  | quiet_template_noise

# Patch the generated JS shim to wrap the email handler the same way
# worker-build wraps fetch. workers-rs rev 3d0903a emits:
#   F.prototype.email=rt;
#   F.prototype.fetch=function(t){return _t.call(this,t,this.env,this.ctx)};
# Cloudflare's WorkerEntrypoint runtime invokes `worker.email(msg)` with
# only the event object — env/ctx come from `this.env`/`this.ctx`. The
# bare assignment loses those, so our Rust handler sees an empty Env
# JsValue (Reflect.ownKeys returns []) and AppConfig::load falls back
# to defaults (PRIMARY_DOMAIN="localhost"), which makes every inbound
# message drop as "not-owned". Wrap email the same way fetch is.
#
# Remove this once we upgrade off the 3d0903a pin to a workers-rs that
# emits the wrapped form natively.
