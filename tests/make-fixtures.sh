#!/usr/bin/env bash
# Regenerates the test images (needs pango-view and ImageMagick).
set -euo pipefail
cd "$(dirname "$0")/fixtures"

cat > letter.txt <<'TXT'
Atelier Martin & Fils — Rue des Vollandes 12, 1207 Genève

Facture n° 2026-1142, le 19 novembre 2026

Objet : réparation du lave-vaisselle et remplacement de la pompe de vidange.
Main-d'œuvre : 2 h 30 à 95,00 CHF, soit 237,50 CHF hors taxes.
Pièces détachées : pompe 00620774, joint d'étanchéité, colliers.
Total TTC : 418,35 CHF, payable à trente jours par virement bancaire.

Pour toute question, appelez le 022 781 45 90 ou écrivez à atelier@exemple.ch.
Conditions générales : https://www.exemple.ch/conditions
TXT

pango-view --no-display --font="Cantarell 13" --dpi=96 --margin=48 --width=560 --wrap=word \
    --background=white --foreground='#222' -o letter.png letter.txt

cat > dark.txt <<'TXT'
Notifications
Backup finished — 1 284 files copied to external drive
Your password expires in 5 days. Visit portal.example.org to change it.
Meeting moved to 15:30, room Léman (2nd floor)
TXT
pango-view --no-display --font="Cantarell 11" --dpi=96 --margin=24 --width=420 --wrap=word \
    --background='#242424' --foreground='#f0f0f0' -o dark.png dark.txt

magick letter.png -rotate 3 -blur 0x1.2 -attenuate 0.5 +noise Gaussian -resize 85% +repage photo.png
magick -size 900x600 plasma:fractal -blur 0x2 -depth 8 notext.png
rm letter.txt dark.txt

# Reference OCR output, made the way the plugin does it (images under 1400 px
# are upscaled x2). Needs the French model: TESSDATA_PREFIX may point to it.
for f in letter dark photo notext; do
    magick "$f.png" -resize 200% png:- |
        tesseract stdin stdout -l eng+fra --psm 3 \
            -c tessedit_create_tsv=1 -c tessedit_create_txt=0 2>/dev/null >"$f.x2.tsv"
done
rm -f letter.tsv dark.tsv photo.tsv notext.tsv
