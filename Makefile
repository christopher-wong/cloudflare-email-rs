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

.PHONY: install web worker build dev deploy clean check openapi

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

clean:
	rm -rf web/dist web/node_modules/.vite
	rm -rf worker/build target

# Regenerate openapi.json from the #[utoipa::path] annotations in
# openapi-gen/. Runs natively (not wasm) and writes to repo root.
openapi:
	cargo run -q -p openapi-gen
