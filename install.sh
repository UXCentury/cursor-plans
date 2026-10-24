#!/usr/bin/env bash
# Package this folder as a VSIX and install it into Cursor.
# Removes leftover copies from earlier publisher ids / versions first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${HOME}/.cursor/extensions"
VSIX="/tmp/uxcentury.cursor-plans.vsix"

cursor --uninstall-extension uxcentury.cursor-plans >/dev/null 2>&1 || true
cursor --uninstall-extension workspace.plans >/dev/null 2>&1 || true
rm -rf "${EXT_DIR}"/uxcentury.cursor-plans-* "${EXT_DIR}"/workspace.plans-*

cd "$ROOT"
npx --yes @vscode/vsce package --no-dependencies \
  --baseContentUrl https://github.com/UXCentury/cursor-plans/raw/main/ \
  --baseImagesUrl https://github.com/UXCentury/cursor-plans/raw/main/ \
  --out "$VSIX"
cursor --install-extension "$VSIX"

echo "Installed uxcentury.cursor-plans"
echo "Reload Cursor: Command Palette → Developer: Reload Window"
