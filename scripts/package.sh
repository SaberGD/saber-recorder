#!/usr/bin/env bash
# بيعمل ملف zip للمدربين من الإكستنشن: bash scripts/package.sh  →  dist/Saber-Recorder-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/Saber-Recorder-$VERSION.zip"
TMP="$(mktemp -d)"
mkdir -p "$TMP/Saber Recorder" dist
cp -r manifest.json config.js background.js popup.html popup.js recorder.html recorder.js styles.css theme.js assets icons lib "$TMP/Saber Recorder/"
cp "docs/INSTALL-AR.txt" "$TMP/Saber Recorder/INSTALL-AR.txt"
rm -f "$OUT"
( cd "$TMP" && zip -qr - "Saber Recorder" ) > "$OUT"
rm -rf "$TMP"
echo "✓ $OUT"
