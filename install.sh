#!/usr/bin/env bash
# Installs Nori as a plugin of GNOME's file previewer (Sushi 51 or later).
#
#   ./install.sh              install for the current user
#   ./install.sh --dev        same, but link to this checkout instead of copying
#   ./install.sh --uninstall
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${XDG_DATA_HOME:-$HOME/.local/share}/sushi/plugins-1

build_translations() {
    while read -r lang; do
        [ -n "$lang" ] || continue
        mkdir -p "$here/plugin/nori/locale/$lang/LC_MESSAGES"
        msgfmt -o "$here/plugin/nori/locale/$lang/LC_MESSAGES/nori.mo" "$here/po/$lang.po"
    done <"$here/po/LINGUAS"
}

restart_previewer() {
    # Sushi reads its plugins at start-up; ask a running one to quit. Check
    # first: calling Close on an absent name would D-Bus-activate a new one.
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.NautilusPreviewer 2>/dev/null |
        grep -q true || return 0
    gdbus call --session --dest org.gnome.NautilusPreviewer \
        --object-path /org/gnome/NautilusPreviewer \
        --method org.gnome.NautilusPreviewer2.Close >/dev/null 2>&1 || true
}

case "${1:-}" in
--uninstall)
    rm -rf "$dest/nori" "$dest/nori-image.js"
    restart_previewer
    echo "Nori removed."
    exit 0
    ;;
--dev | "") ;;
*) echo "usage: $0 [--dev | --uninstall]" >&2; exit 2 ;;
esac

if ! sushi_version=$(dpkg-query -W -f='${Version}' gnome-sushi 2>/dev/null || rpm -q --qf '%{VERSION}' sushi 2>/dev/null); then
    sushi_version=unknown
fi
case "$sushi_version" in
[0-4]* | 50*) echo "Nori needs Sushi 51 or later (found $sushi_version)." >&2; exit 1 ;;
esac

command -v msgfmt >/dev/null && build_translations
mkdir -p "$dest"
rm -rf "$dest/nori" "$dest/nori-image.js"
if [ "${1:-}" = --dev ]; then
    ln -s "$here/plugin/nori" "$dest/nori"
    ln -s "$here/plugin/nori-image.js" "$dest/nori-image.js"
else
    cp -r "$here/plugin/nori" "$here/plugin/nori-image.js" "$dest/"
fi
restart_previewer
echo "Nori installed in $dest."

if ! command -v tesseract >/dev/null; then
    echo "Tesseract is missing: install it, e.g. 'sudo apt install tesseract-ocr'." >&2
else
    langs=$(tesseract --list-langs 2>/dev/null | tail -n +2 | grep -v -x -e osd -e equ | tr '\n' ' ')
    echo "Text recognition languages: ${langs:-none}"
    echo "More languages: e.g. 'sudo apt install tesseract-ocr-fra tesseract-ocr-deu'."
fi
