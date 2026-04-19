#!/usr/bin/env bash
#
# Build Canopy for Linux x86_64 using Docker.
# Outputs: dist/linux/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/dist/linux"

cd "$PROJECT_DIR"

echo "==> Building Linux x86_64 release in Docker..."

docker build \
    --platform linux/amd64 \
    -f Dockerfile.linux-build \
    -t canopy-linux-builder \
    .

echo "==> Extracting build artifacts..."
mkdir -p "$OUTPUT_DIR"

# Create a temporary container and copy out the bundles
CONTAINER_ID=$(docker create canopy-linux-builder)
docker cp "$CONTAINER_ID:/app/src-tauri/target/release/bundle/deb" "$OUTPUT_DIR/" 2>/dev/null || true
docker cp "$CONTAINER_ID:/app/src-tauri/target/release/bundle/rpm" "$OUTPUT_DIR/" 2>/dev/null || true
docker cp "$CONTAINER_ID:/app/src-tauri/target/release/bundle/appimage" "$OUTPUT_DIR/" 2>/dev/null || true
docker cp "$CONTAINER_ID:/app/src-tauri/target/release/canopy" "$OUTPUT_DIR/canopy" 2>/dev/null || true
docker rm "$CONTAINER_ID" > /dev/null

echo ""
echo "==> Done! Linux artifacts in: $OUTPUT_DIR"
ls -lhR "$OUTPUT_DIR"
