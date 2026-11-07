#!/bin/sh
# Builds the upload file for the Chrome Web Store: dist/swd-guard-<version>.zip
# Only what the extension needs goes in (manifest, _locales, icons, src, data); no tests, scripts or docs.
set -eu
cd "$(dirname "$0")/.."
node scripts/check.mjs
node --test test/common.test.mjs >/dev/null
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
OUT="dist/swd-guard-$VERSION.zip"
rm -f "$OUT"
zip -q -r -X "$OUT" manifest.json _locales icons src data
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
unzip -l "$OUT" | tail -1
