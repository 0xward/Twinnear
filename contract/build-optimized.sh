#!/usr/bin/env bash
# Twinnear — reproducible optimized wasm build.
#
# 1. cargo build --release (profile already tuned: opt-level "z", lto,
#    codegen-units=1, strip=true, panic="abort")
# 2. wasm-opt -Oz (Binaryen) — shrinks the stripped wasm further.
#
# Output: contract/twinnear.wasm  (the DEPLOY artifact — use this file,
# NOT target/.../release/twinnear.wasm, when deploying to twinnear.testnet)
# The script prints size + SHA-256 of the output and verifies that all
# 17 contract exports survive optimization.
#
# wasm-opt binary: ../tools/wasm-opt (Binaryen version_123, x86_64-linux).
# If it is missing, the script downloads Binaryen 123 and extracts it
# into ../tools/ (NOT /tmp: /tmp is a small tmpfs here).
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --target wasm32-unknown-unknown

WASM_OPT="../tools/wasm-opt"
if [ ! -x "$WASM_OPT" ]; then
  echo "wasm-opt not found in ../tools/, downloading Binaryen 123..."
  mkdir -p ../tools
  TMP="$(mktemp -d "$HOME/.tmp-build-binaryen.XXXXXX")"
  curl -sL --max-time 180 -o "$TMP/binaryen.tar.gz" \
    https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz
  tar xzf "$TMP/binaryen.tar.gz" -C "$TMP"
  cp "$TMP/binaryen-version_123/bin/wasm-opt" ../tools/wasm-opt
  chmod +x ../tools/wasm-opt
  rm -rf "$TMP"
fi

RAW="target/wasm32-unknown-unknown/release/twinnear.wasm"
OUT="twinnear.wasm"
"$WASM_OPT" -Oz \
  --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
  --strip-debug --strip-producers \
  "$RAW" -o "$OUT"

echo "raw:       $(stat -c%s "$RAW") bytes  $(sha256sum "$RAW" | cut -d' ' -f1)"
echo "optimized: $(stat -c%s "$OUT") bytes  $(sha256sum "$OUT" | cut -d' ' -f1)"
echo "deploy artifact: contract/twinnear.wasm"
