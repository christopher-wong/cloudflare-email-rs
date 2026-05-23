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

# Ensure the builder is available. Idempotent — does nothing if already
# installed at the requested version.
cargo install -q worker-build@^0.8

# Run the build, filtering the templates noise. `pipefail` ensures we exit
# non-zero if worker-build fails, even when the filter runs cleanly.
worker-build --release 2>&1 \
  | awk '
      /^error: (invalid character .* in package name|missing key for inline table element)/ {
        skip = 4
        next
      }
      skip > 0 { skip--; next }
      { print }
    '
