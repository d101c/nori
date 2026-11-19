# Changelog

## 0.2 — unreleased

- Scanned PDFs: pages without text get an invisible text layer in the
  background (pdftoppm + Tesseract + qpdf overlay), then the preview reloads
  at the same page so Sushi's PDF selection and Ctrl+C work on scans. Mixed
  documents keep their real text; rotated pages are handled; the original
  file is never modified. Progress spinner in the page bar.

## 0.1 — unreleased

- Selectable text in previewed images: drag, double and triple click,
  Ctrl+C, Ctrl+A, right-click menu.
- Links, e-mail addresses and phone numbers: underlined on hover, with
  Open / Send Email / Copy actions.
- Show Text mode and Copy All Text button, bottom right.
- Tesseract in the background, with per-file cache and cancellation when
  moving to another file; recognised text exposed to screen readers.
- French translation.
