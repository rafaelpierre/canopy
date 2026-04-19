#!/usr/bin/env bash
#
# Build Canopy for Linux using Docker/Podman.
# Outputs: dist/linux/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/dist/linux"

# Use podman if available, otherwise docker
CMD="${CONTAINER_CMD:-$(command -v podman || command -v docker)}"

cd "$PROJECT_DIR"

echo "==> Building Linux release with $CMD..."

$CMD build \
    -f Dockerfile.linux-build-rhel8 \
    -t canopy-linux-builder \
    .

echo "==> Extracting build artifacts..."
mkdir -p "$OUTPUT_DIR"

# Create a temporary container and copy out the bundles
CONTAINER_ID=$($CMD create canopy-linux-builder)
$CMD cp "$CONTAINER_ID:/app/src-tauri/target/release/bundle/rpm" "$OUTPUT_DIR/" 2>/dev/null || true
$CMD cp "$CONTAINER_ID:/app/src-tauri/target/release/canopy" "$OUTPUT_DIR/canopy" 2>/dev/null || true
$CMD rm "$CONTAINER_ID" > /dev/null

echo ""
echo "==> Done! Linux artifacts in: $OUTPUT_DIR"
ls -lhR "$OUTPUT_DIR"
