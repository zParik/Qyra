import { useEffect, useState } from "react";

export interface SelectionPopupState {
  text: string;
  rect: DOMRect;
  pageIndex: number;
  normX: number;
  normY: number;
}

export interface SelectionEditorState {
  text: string;
  screenX: number;
  screenY: number;
  pageIndex: number;
  normX: number;
  normY: number;
}

export interface SelectionLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageSelectionGeometry {
  /** 1-based page number (matches data-page-index / add_pdf_annotation). */
  page: number;
  /** One normalized (top-left origin) rect per selected text line on this page. */
  lines: SelectionLine[];
  /** Bounding box of all lines on this page, normalized top-left. */
  bbox: SelectionLine;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Read the live text selection and group its per-line client rects by the page
 * they fall on. Drives highlight/underline/strikeout/redact from the selection
 * popup. Coordinates are normalized to each page (top-left origin) — the same
 * convention add_pdf_annotation and RedactRegion expect.
 */
export function getSelectionGeometry(): PageSelectionGeometry[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];

  const pageEls = Array.from(
    document.querySelectorAll<HTMLElement>("[data-page-index]")
  ).map((el) => ({ page: parseInt(el.dataset.pageIndex!, 10), rect: el.getBoundingClientRect() }));

  const byPage = new Map<number, SelectionLine[]>();
  for (let ri = 0; ri < sel.rangeCount; ri++) {
    for (const r of Array.from(sel.getRangeAt(ri).getClientRects())) {
      if (r.width <= 0.5 || r.height <= 0.5) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const pg = pageEls.find(
        (p) =>
          p.rect.width > 0 && p.rect.height > 0 &&
          cx >= p.rect.left && cx <= p.rect.right &&
          cy >= p.rect.top && cy <= p.rect.bottom
      );
      if (!pg) continue;
      const line: SelectionLine = {
        x0: clamp01((r.left - pg.rect.left) / pg.rect.width),
        y0: clamp01((r.top - pg.rect.top) / pg.rect.height),
        x1: clamp01((r.right - pg.rect.left) / pg.rect.width),
        y1: clamp01((r.bottom - pg.rect.top) / pg.rect.height),
      };
      const arr = byPage.get(pg.page);
      if (arr) arr.push(line);
      else byPage.set(pg.page, [line]);
    }
  }

  return Array.from(byPage.entries()).map(([page, lines]) => ({
    page,
    lines,
    bbox: {
      x0: Math.min(...lines.map((l) => l.x0)),
      y0: Math.min(...lines.map((l) => l.y0)),
      x1: Math.max(...lines.map((l) => l.x1)),
      y1: Math.max(...lines.map((l) => l.y1)),
    },
  }));
}

/**
 * Tracks the user's text selection inside any TextLayer page and exposes a
 * popup (with the "Add Comment" button) and a follow-on editor state.
 */
export function useTextSelection() {
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopupState | null>(null);
  const [selectionEditor, setSelectionEditor] = useState<SelectionEditorState | null>(null);

  // Recompute the popup from the current selection. Driven by two events:
  //  - pointerup: instant feedback for desktop mouse-drag selection.
  //  - selectionchange (debounced): the touch path. A long-press selection on
  //    mobile makes the browser seize the pointer and fire pointercancel, not
  //    pointerup, so pointerup alone would never raise the popup on touch.
  useEffect(() => {
    function computePopup() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionPopup(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el = container.nodeType === 3 ? container.parentElement : (container as HTMLElement);
      // We only care about selections within a TextLayer.
      const pageEl = el?.closest(".textLayer")?.parentElement as HTMLElement | null;

      if (!pageEl || !pageEl.dataset.pageIndex) {
        setSelectionPopup(null);
        return;
      }

      const pageIndex = parseInt(pageEl.dataset.pageIndex, 10);
      const pageRect = pageEl.getBoundingClientRect();
      const selRect = range.getBoundingClientRect();

      const normX = (selRect.left + selRect.width / 2 - pageRect.left) / pageRect.width;
      const normY = (selRect.top - pageRect.top) / pageRect.height;
      const text = sel.toString().trim();

      if (!text) {
        setSelectionPopup(null);
        return;
      }

      setSelectionPopup({
        text,
        rect: selRect,
        pageIndex,
        normX,
        normY,
      });
    }

    function handlePointerUp(e: PointerEvent) {
      // Ignore right-click and middle-click on desktop.
      if (e.button > 0) return;
      computePopup();
    }

    // selectionchange fires continuously while dragging a selection (or its
    // handles on touch) — debounce so the popup settles on the final range.
    let debounce: number | null = null;
    function handleSelectionChange() {
      if (debounce != null) clearTimeout(debounce);
      debounce = window.setTimeout(computePopup, 200);
    }

    document.addEventListener("pointerup", handlePointerUp as EventListener);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("pointerup", handlePointerUp as EventListener);
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (debounce != null) clearTimeout(debounce);
    };
  }, []);

  return {
    selectionPopup,
    setSelectionPopup,
    selectionEditor,
    setSelectionEditor,
  };
}
