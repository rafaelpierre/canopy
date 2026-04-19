#!/usr/bin/env bash
#
# Downloads basedpyright wheels for bundling inside the Canopy app.
# Run this on a machine with internet access before building the final app.
#
# Usage:
#   ./scripts/bundle-lsp.sh                     # current platform
#   ./scripts/bundle-lsp.sh linux x86_64        # cross-platform
#   ./scripts/bundle-lsp.sh linux aarch64
#   ./scripts/bundle-lsp.sh macos x86_64
#   ./scripts/bundle-lsp.sh macos aarch64
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$PROJECT_DIR/resources/lsp-wheels"

OS="${1:-}"
ARCH="${2:-}"

# Map to pip platform tags
resolve_platform_args() {
    if [[ -z "$OS" ]]; then
        # Auto-detect: no platform constraint, download for current system
        PLATFORM_ARGS=""
        return
    fi

    case "$OS-$ARCH" in
        linux-x86_64)
            PLATFORM_ARGS="--platform manylinux2014_x86_64 --platform linux_x86_64" ;;
        linux-aarch64)
            PLATFORM_ARGS="--platform manylinux2014_aarch64 --platform linux_aarch64" ;;
        macos-x86_64)
            PLATFORM_ARGS="--platform macosx_10_16_x86_64" ;;
        macos-aarch64|macos-arm64)
            PLATFORM_ARGS="--platform macosx_11_0_arm64" ;;
        *)
            echo "Error: unsupported platform '$OS-$ARCH'"
            echo "Supported: linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64"
            exit 1 ;;
    esac

    # Cross-download requires --only-binary and explicit python version
    PLATFORM_ARGS="$PLATFORM_ARGS --only-binary=:all: --python-version 3.12"
}

resolve_platform_args

echo "==> Downloading basedpyright wheels..."
echo "    Destination: $DEST_DIR"
[[ -n "$PLATFORM_ARGS" ]] && echo "    Platform:    $OS $ARCH"

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

# Use uv-managed Python's pip if available (modern pip handles manylinux_2_17),
# otherwise fall back to system pip3
if command -v uv &>/dev/null; then
    PIP_DL="uv run --python 3.12 pip download"
else
    PIP_DL="pip3 download"
fi

# Download basedpyright only (--no-deps: we use Electron's bundled Node.js
# instead of nodejs-wheel-binaries, saving ~58MB)
# shellcheck disable=SC2086
$PIP_DL \
    basedpyright \
    --dest "$DEST_DIR" \
    --no-cache-dir \
    --no-deps \
    $PLATFORM_ARGS

# Count what we got
WHEEL_COUNT=$(find "$DEST_DIR" -name '*.whl' | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$DEST_DIR" | cut -f1)

echo ""
echo "==> Done. $WHEEL_COUNT wheels downloaded ($TOTAL_SIZE)"
echo ""
echo "Contents:"
ls -1 "$DEST_DIR"
echo ""
echo "These will be bundled into the Canopy app at build time."
echo "On first launch, they'll be installed into ~/.local/share/canopy/lsp/"
