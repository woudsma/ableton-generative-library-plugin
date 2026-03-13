#!/usr/bin/env bash
#
# Package the Generative Library plugin into a distributable ZIP file.
#
# Usage:
#   npm run package
#   # or directly:
#   bash scripts/package.sh
#
# Output:
#   dist/GenerativeLibrary-v{version}.zip
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Get version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
DIST_DIR="$PROJECT_ROOT/dist"
ARCHIVE_NAME="GenerativeLibrary-v${VERSION}"
STAGING_DIR="$DIST_DIR/$ARCHIVE_NAME"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Packaging Generative Library v${VERSION}"
echo "═══════════════════════════════════════════════"
echo ""

# ─── 1. Build the .amxd device ───
echo "[1/3] Building Max for Live device..."
python3 scripts/build_amxd.py
echo ""

# ─── 2. Create staging directory ───
echo "[2/3] Staging files..."

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Core files
cp install.sh "$STAGING_DIR/"
cp package.json "$STAGING_DIR/"
[ -f package-lock.json ] && cp package-lock.json "$STAGING_DIR/"
cp README.md "$STAGING_DIR/"
cp vitest.config.ts "$STAGING_DIR/"

# Max device
mkdir -p "$STAGING_DIR/max-device"
cp max-device/GenerativeLibrary.amxd "$STAGING_DIR/max-device/"
cp max-device/generative-library.js "$STAGING_DIR/max-device/"
cp max-device/BUILD_INSTRUCTIONS.md "$STAGING_DIR/max-device/"

# Server source
mkdir -p "$STAGING_DIR/server/src"
mkdir -p "$STAGING_DIR/server/data"
mkdir -p "$STAGING_DIR/server/logs"
cp server/tsconfig.json "$STAGING_DIR/server/"
# Copy all TypeScript source files
for f in server/src/*.ts; do
  cp "$f" "$STAGING_DIR/server/src/"
done

# Scripts
mkdir -p "$STAGING_DIR/scripts"
cp scripts/build_amxd.py "$STAGING_DIR/scripts/"
[ -f scripts/list-unique-files.sh ] && cp scripts/list-unique-files.sh "$STAGING_DIR/scripts/"

# Keep .gitkeep files so empty dirs are preserved in the zip
touch "$STAGING_DIR/server/data/.gitkeep"
touch "$STAGING_DIR/server/logs/.gitkeep"

# Make install.sh executable in the staging dir
chmod +x "$STAGING_DIR/install.sh"

echo "  Staged $(find "$STAGING_DIR" -type f | wc -l | tr -d ' ') files"

# ─── 3. Create ZIP ───
echo "[3/3] Creating ZIP archive..."

mkdir -p "$DIST_DIR"
cd "$DIST_DIR"
rm -f "${ARCHIVE_NAME}.zip"
zip -rq "${ARCHIVE_NAME}.zip" "$ARCHIVE_NAME"

ZIP_SIZE=$(du -h "${ARCHIVE_NAME}.zip" | cut -f1 | tr -d ' ')

# Clean up staging
rm -rf "$STAGING_DIR"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ Package created!"
echo "═══════════════════════════════════════════════"
echo ""
echo "  File: dist/${ARCHIVE_NAME}.zip"
echo "  Size: ${ZIP_SIZE}"
echo ""
echo "  Share this ZIP with friends. They unzip and run:"
echo "    cd ${ARCHIVE_NAME}"
echo "    ./install.sh"
echo ""
