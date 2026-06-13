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
