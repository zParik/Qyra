# Changelog

All notable changes to Qyra are documented here. The format is hand-curated;
each release entry is injected into its GitHub release body on tag.

## [Unreleased]

_Entries accumulate here. At release time, rename this heading to
`## [<version>] — <YYYY-MM-DD> · <tagline>`._

## [2.0.0] — 2026-11-04 · The Revamp

Most of Qyra was rewritten between October and November 2026. Pages are
sharper, the app uses a fraction of the memory and CPU, files you edit keep
everything you put in them, and the whole interface has a new look. Qyra is
now built for Linux and Windows only.

On Linux, install or update with:

```bash
curl -fsSL https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.sh | bash
```

---

### Rendering and speed

- **Sharp pages.** MuPDF renders raw pixels in 512 px tiles drawn 1:1 to
  your screen's device pixels, instead of JPEGs sent as base64 and stretched.
- **Lighter.** Opening a 60 MB PDF on a release build: memory 977 MB to about
  380 MB, peak RSS 2.2 GB to 250 MB, CPU time about 200 s to about 1 s.
  A scripted 8-second scroll went from 7.5 to 4.2 CPU-seconds.
- Only the visible tab reacts to keys and the mouse wheel.

### Fixes that kept your work

- Filled-in forms and placed signatures are now saved into the file.
  Checkboxes, radio buttons and fields with the same short name work.
- Drawings are no longer written twice on a second save, survive other
  edits, and mark the tab unsaved.
- Editing a PDF that has an owner password keeps it protected.
- Highlights, comments, drawings, links, crop, OCR text and signatures land
  in the right place on rotated and cropped pages.
- Accented and non-Latin text in metadata, bookmarks and annotations saves
  in a form other viewers read.
- Batch jobs no longer overwrite outputs when two inputs share a name.

### Compressor

- PNG predictors are undone per pixel, not per byte, which garbled colour
  images even at the lossless level.
- Object generations, `/Decode` arrays for CMYK and indexed images, and
  deleted objects in edited files are handled correctly.
- Damaged or hostile files can no longer crash or hang it.

### New look

- White paper, an indigo tab bar, rose for actions, one type family (Geist)
  and readable sizes across the viewer, tool pages, settings and dialogs.
- Tool families keep one colour everywhere, so tools are found by colour.
- Sidebars collapse on their own in small windows.
- The logo is a white peacock.

### Desktop

- Opening a PDF while Qyra runs adds a tab to the running window instead of
  starting a second copy.
- "Open with Qyra" from a Linux file manager now passes the file.
- On Wayland with NVIDIA, Qyra sets `__NV_DISABLE_EXPLICIT_SYNC=1` so the
  GPU renderer starts; scrolling no longer falls back to CPU compositing.

### Removed

- macOS and Android builds.
- PDF to Word export.
- Tesseract.js. OCR uses MuPDF's built-in Tesseract with English data
  bundled, still fully offline.

---

### What comes next

- Native printing. Printing still goes through the web view, which on Linux
  mostly offers print-to-file.

## [1.4.0] — 2026-06-30 · Inline Markup

Text markup moves onto the selection itself. The fixed annotation toolbar is
gone; selecting text in the viewer now raises an inline popup with highlight,
redact, and markup actions — on desktop and touch alike.

---

### Features

- **Inline selection toolbar.** Selecting text surfaces an anchored popup with
  highlight / redact / markup actions, replacing the standalone annotation
  toolbar (`AnnotationToolbar` and `AnnotationLayer` removed).
- **Touch selection.** Long-press to select text on touch devices; the
  selection popup raises via `selectionchange`.

---

### Bug fixes

- Re-enable pinch-to-zoom on mobile.

---

### What comes next

- Highlight-anchored comments and incremental save for large files.
