# Changelog

## 0.2 — unreleased

- Scanned PDFs: pages without text get an invisible text layer in the
  background (pdftoppm + Tesseract + qpdf overlay), then the preview reloads
  at the same page so Sushi's PDF selection and Ctrl+C work on scans. Mixed
  documents keep their real text; rotated pages are handled; the original
  file is never modified. Progress spinner in the page bar.
- Long scans: pages are read nearest-first from the page on screen and
  follow the reader; the preview reloads in steps (as soon as the visible
  page is ready, at most every 4 s, never during a selection, keeping the
  scroll position) and once at the end; pages are cached one by one so a
  later preview resumes; up to 200 pages; cache capped at 500 MB.
- qpdf always works in /tmp, whatever TMPDIR says (AppArmor).
- Nori now ships its own copies of Sushi's image and PDF viewers
  (`plugin/nori/vendor/`), as Sushi's maintainers suggested (sushi#179), and
  only imports Sushi's stable `plugin-api-1.js`: upstream changes to the
  built-in viewers (such as sushi#177) no longer break it.

## 0.1 — unreleased

- Selectable text in previewed images: drag, double and triple click,
  Ctrl+C, Ctrl+A, right-click menu.
- Links, e-mail addresses and phone numbers: underlined on hover, with
  Open / Send Email / Copy actions.
- Show Text mode and Copy All Text button, bottom right.
- Tesseract in the background, with per-file cache and cancellation when
  moving to another file; recognised text exposed to screen readers.
- French translation.
