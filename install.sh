#!/usr/bin/env bash
#
# Generative Library — Installation Script
#
# Run this after unzipping the plugin:
#   cd GenerativeLibrary
#   ./install.sh
#
# What this script does:
#   1. Checks that Node.js >= 18 is installed
#   2. Runs npm install to fetch server dependencies
#   3. Copies the AbletonJS MIDI Remote Script to Ableton's User Library
#   4. Builds the Max for Live .amxd device
#
set -euo pipefail

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Generative Library — Installer${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo ""

# ─── 1. Check Node.js ───
echo -e "${BLUE}[1/4]${NC} Checking Node.js..."

if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js is not installed.${NC}"
  echo ""
  echo "  Please install Node.js 18 or later:"
  echo "    • Homebrew:  brew install node"
  echo "    • nvm:       nvm install 18"
  echo "    • Direct:    https://nodejs.org"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗ Node.js version $(node -v) is too old. Version 18+ is required.${NC}"
  echo ""
  echo "  Please upgrade Node.js:"
  echo "    • Homebrew:  brew upgrade node"
  echo "    • nvm:       nvm install 18"
  echo "    • Direct:    https://nodejs.org"
  echo ""
  exit 1
fi

echo -e "  ${GREEN}✓${NC} Node.js $(node -v) found"

# ─── 2. Install npm dependencies ───
echo -e "${BLUE}[2/4]${NC} Installing npm dependencies..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -d "node_modules" ] && [ -f "package-lock.json" ]; then
  echo "  Running npm ci (clean install from lockfile)..."
  npm ci --loglevel=warn
else
  echo "  Running npm install..."
  npm install --loglevel=warn
fi

echo -e "  ${GREEN}✓${NC} Dependencies installed"

# ─── 3. Install AbletonJS MIDI Remote Script ───
echo -e "${BLUE}[3/4]${NC} Installing AbletonJS MIDI Remote Script..."

REMOTE_SCRIPTS_DIR="$HOME/Music/Ableton/User Library/Remote Scripts/AbletonJS"

if [ -d "$REMOTE_SCRIPTS_DIR" ]; then
  echo "  AbletonJS Remote Script folder already exists — updating..."
fi

mkdir -p "$REMOTE_SCRIPTS_DIR"

if [ -d "node_modules/ableton-js/midi-script" ]; then
  cp -r node_modules/ableton-js/midi-script/* "$REMOTE_SCRIPTS_DIR/"
  echo -e "  ${GREEN}✓${NC} Remote Script installed to:"
  echo "    $REMOTE_SCRIPTS_DIR"
else
  echo -e "  ${RED}✗ Could not find ableton-js midi-script files.${NC}"
  echo "    Try running 'npm install' manually and re-run this script."
  exit 1
fi

# ─── 4. Build the Max for Live device ───
echo -e "${BLUE}[4/4]${NC} Building Max for Live device..."

if command -v python3 &> /dev/null; then
  python3 scripts/build_amxd.py
  echo -e "  ${GREEN}✓${NC} Device built: max-device/GenerativeLibrary.amxd"
else
  echo -e "  ${YELLOW}⚠${NC} Python 3 not found — skipping .amxd build."
  echo "    The pre-built GenerativeLibrary.amxd should still work."
fi

# ─── Done! ───
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✓ Installation complete!${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo "  1. Open Ableton Live 12"
echo ""
echo "  2. Enable the AbletonJS control surface:"
echo "     Settings → Link/Tempo/MIDI → Control Surface"
echo "     → select 'AbletonJS' (leave Input/Output as 'None')"
echo ""
echo "  3. Start the server in a terminal:"
echo "     cd $(pwd) && npm run dev"
echo ""
echo "  4. Drag the device onto any track:"
echo "     max-device/GenerativeLibrary.amxd"
echo ""
echo -e "  ${YELLOW}Tip:${NC} Keep the terminal open while using the plugin."
echo "  The server must be running for the device to work."
echo ""
