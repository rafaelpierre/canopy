#!/usr/bin/env bash
#
# Build Canopy for Linux (Ubuntu/Debian) using Docker/Podman.
# Outputs: dist/linux/ubuntu-<arch>-<version>.tar.gz
#
# Usage:
#   ./scripts/build-linux.sh              # amd64 (default)
#   PLATFORM=linux/arm64 ./scripts/build-linux.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/dist/linux"

PLATFORM="${PLATFORM:-linux/amd64}"
ARCH="${PLATFORM##*/}"   # arm64 or amd64
ARCH_SHORT="${ARCH/amd64/x64}"
ARCH_SHORT="${ARCH_SHORT/arm64/arm}"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"

# Use podman if available, otherwise docker
CMD="${CONTAINER_CMD:-$(command -v podman || command -v docker)}"

cd "$PROJECT_DIR"

echo "==> Building Linux release ($PLATFORM) with $CMD..."

$CMD build \
    --platform "$PLATFORM" \
    --build-arg TARGETARCH="$ARCH" \
    -f Dockerfile.linux-build \
    -t canopy-linux-builder \
    .

echo "==> Extracting build artifacts..."
mkdir -p "$OUTPUT_DIR"

# Create a temporary container and copy out the tarball
CONTAINER_ID=$($CMD create canopy-linux-builder)
$CMD cp "$CONTAINER_ID:/app/dist-electron/canopy-linux-${ARCH}.tar.gz" "$OUTPUT_DIR/ubuntu-${ARCH_SHORT}-${VERSION}.tar.gz"
$CMD rm "$CONTAINER_ID" > /dev/null

echo ""
echo "==> Done! Linux artifacts in: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"
