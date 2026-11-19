#!/usr/bin/env bash
# Unit tests, then (when Tesseract and Broadway are available) an end-to-end
# run of the real renderer on every fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
gjs -m tests/layout.test.js

if ! command -v tesseract >/dev/null || ! command -v gtk4-broadwayd >/dev/null; then
    echo "skipping end-to-end test (needs tesseract and gtk4-broadwayd)"
    exit 0
fi
out=$(mktemp -d)
trap 'kill "$broadway" 2>/dev/null; rm -rf "$out"' EXIT
gtk4-broadwayd :9 >/dev/null 2>&1 &
broadway=$!
sleep 0.5
export GDK_BACKEND=broadway BROADWAY_DISPLAY=:9 GTK_A11Y=none XDG_CACHE_HOME="$out/cache"
for f in letter dark photo; do
    printf 'e2e %-7s ' "$f"
    gjs -m tools/render.js "tests/fixtures/$f.png" "$out/$f.png" select-all 2>/dev/null | head -1
done
printf 'e2e %-7s ' notext
if gjs -m tools/render.js tests/fixtures/notext.png "$out/notext.png" 2>/dev/null | head -1; then
    echo "FAIL: text found in an image without text"; exit 1
fi

if command -v pdftoppm >/dev/null && command -v qpdf >/dev/null; then
    XDG_CACHE_HOME="$out/pdf-cache" gjs -m tests/pdf.test.js
    # A 12-page scan, jumping to page 9 while it is being read.
    pages=(); for _ in $(seq 6); do pages+=(tests/fixtures/scan.pdf); done
    qpdf --empty --pages "${pages[@]}" -- "$out/long.pdf"
    printf 'e2e long PDF, jump to page 9: '
    XDG_CACHE_HOME="$out/drive-cache" gjs -m tools/pdf-drive.js "$out/long.pdf" 9 800 2>/dev/null | tail -1
else
    echo "skipping PDF tests (needs poppler-utils and qpdf)"
fi
