#!/usr/bin/env bash
# Builds the contract in the pinned cargo-near image. A host build on macOS
# compiles ring without its C code, because Apple clang has no wasm backend.
set -euo pipefail

IMAGE='sourcescan/cargo-near:0.19.0-rust-1.86.0@sha256:772638e343baeeea24e49062c7d424274f3441452cc06ce97fc4e5695b19fecc'
PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm --platform linux/amd64 \
  -v "$PACKAGE_DIR/contracts/trigger:/code" -w /code \
  -e CARGO_TARGET_DIR=/tmp/target \
  "$IMAGE" \
  bash -c 'cargo near build non-reproducible-wasm --locked --no-abi --out-dir /tmp/out && cp /tmp/out/covantic_trigger.wasm /code/res/'

cd "$PACKAGE_DIR"
pnpm exec tsx scripts/check-wasm.ts
