# cfemail — minimal build & deploy targets.
#
#   make install      install node deps + rust toolchain bits
#   make web          build the frontend (Vite -> web/dist)
#   make worker       build the worker (cargo + worker-build -> worker/build)
#   make build        build everything
#   make dev          run wrangler dev (frontend + worker, hot reload)
#   make deploy       build + wrangler deploy
#   make clean        nuke build artifacts
#
# Configuration lives in wrangler.jsonc (vars block). The Rust target is
# wasm32-unknown-unknown; `make install` adds it if missing.

.PHONY: install web worker build dev deploy clean check test test-web test-worker openapi check-openapi

install:
	npm install
	npm --prefix web install
	rustup target add wasm32-unknown-unknown
	cargo install -q worker-build@^0.8 || true

web:
	npm --prefix web run build

worker:
	bash scripts/build-worker.sh

build: web worker

dev:
	npx wrangler dev

deploy: build
	npx wrangler deploy

check:
	cargo check --manifest-path worker/Cargo.toml --target wasm32-unknown-unknown
	npm --prefix web run typecheck

# Run all unit tests.
#   worker: cargo test on the native target (wasm-bindgen externs are gated
#           with #[cfg(target_arch = "wasm32")] where they'd panic).
#   web:    vitest run with happy-dom.
test: test-worker test-web

test-worker:
	cargo test --lib --manifest-path worker/Cargo.toml

test-web:
	npm --prefix web run test

clean:
	rm -rf web/dist web/node_modules/.vite
	rm -rf worker/build target

# Regenerate openapi.json from the #[utoipa::path] annotations in
# openapi-gen/. Runs natively (not wasm) and writes to repo root.
# Also regenerates web/src/lib/api-types.ts from the fresh spec so
# the frontend stays in sync — TS typecheck will catch any drift on
# the next `make check`.
#
# Drift between worker handlers and the spec is already prevented
# structurally: every request/response struct lives once, in the
# `cfemail-api-types` workspace crate. A handler that grows a field
# without updating the shared struct fails to compile in `worker/`.
openapi:
	cargo run -q -p openapi-gen
	npm --prefix web run gen:types

# CI hook: regenerate the spec + TS types and fail if anything moved
# (i.e. a contributor edited an api-types struct, ran the worker
# tests, but forgot `make openapi`).
check-openapi:
	@$(MAKE) -s openapi
	@if ! git diff --quiet -- openapi.json web/src/lib/api-types.ts; then \
		echo "ERROR: openapi.json or api-types.ts is out of date — run 'make openapi' and commit."; \
		git --no-pager diff -- openapi.json web/src/lib/api-types.ts | head -40; \
		exit 1; \
	fi
