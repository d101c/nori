# Viewers copied from Sushi

These files come from Sushi 51.0 (GNOME's file previewer,
https://gitlab.gnome.org/GNOME/sushi, GPL-2.0-or-later WITH
GStreamer-exception-2008). Sushi's maintainers consider its own viewers an
implementation detail and suggested copying them into the plugin rather than
extending them (sushi#179), so that Nori only depends on the stable
`plugin-api-1.js`.

| File | From | Changes |
|---|---|---|
| `image.js` | `src/viewers/image.js` | imports from `plugin-api-1.js` and local copies; GType name `NoriImageView` |
| `pdf.js` | `src/viewers/pdf.js` | same; GType name `NoriPdfView`; template loaded from `pdf.ui` next to it; PDF only (no LibreOffice conversion, no content-type list) |
| `pdf.ui` | `data/ui/pdf.ui` (compiled) | template class renamed to `NoriPdfView` |
| `error.js`, `source.js`, `connection.js` | `src/util/` | unchanged |

When Sushi releases a new version, compare these files with upstream and
bring over the fixes that matter.
