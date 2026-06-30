# Changelog

All notable changes to Qyra are documented here. The format is hand-curated;
each release entry is injected into its GitHub release body on tag.

## [Unreleased]

_Entries accumulate here. At release time, rename this heading to
`## [<version>] — <YYYY-MM-DD> · <tagline>`._

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
