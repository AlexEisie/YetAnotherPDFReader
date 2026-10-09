#!/usr/bin/env bash
# Build the Linux packages (.deb, .rpm, .AppImage).
#
# Works on a Linux machine or in WSL (Ubuntu 22.04 recommended: its glibc 2.35 keeps the
# packages compatible with most current distributions). From Windows:
#
#   wsl -d Ubuntu-22.04 -- bash scripts/build-linux.sh
#
# Prerequisites (Debian / Ubuntu):
#   sudo apt install build-essential curl file libwebkit2gtk-4.1-dev libgtk-3-dev \
#     librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev patchelf rpm rsync
#   Rust (rustup, stable) and Node.js >= 20.19
#
# When the sources live on a Windows drive (/mnt/...), they are copied into the Linux file
# system first, which is much faster to build from. Packages end up in target/linux-bundle/
# next to this script's repository.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$repo"
if [[ "$repo" == /mnt/* ]]; then
  work="$HOME/.cache/yapr-linux-build"
  mkdir -p "$work"
  rsync -a --delete \
    --exclude node_modules --exclude target --exclude dist --exclude .git \
    --exclude 'public/pdfjs' --exclude 'src-tauri/gen' --exclude 'src-tauri/ocr/linux' \
    "$repo/" "$work/"
fi

# ONNX Runtime (OCR) is loaded at run time on Linux; ship Microsoft's official build, which
# runs on glibc 2.28+.
ort_version="1.22.0"
ort_dir="$work/src-tauri/ocr/linux"
if [[ ! -f "$ort_dir/libonnxruntime.so" ]]; then
  mkdir -p "$ort_dir"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v${ort_version}/onnxruntime-linux-x64-${ort_version}.tgz" | tar -xz -C "$tmp"
  cp -L "$tmp/onnxruntime-linux-x64-${ort_version}/lib/libonnxruntime.so" "$ort_dir/libonnxruntime.so"
  rm -rf "$tmp"
fi

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$work/target"
cd "$work"
npm ci --no-audit --no-fund
npx tauri build --bundles deb,rpm,appimage

out="$repo/target/linux-bundle"
mkdir -p "$out"
find "$CARGO_TARGET_DIR/release/bundle" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp -f {} "$out/" \;
ls -la "$out"
