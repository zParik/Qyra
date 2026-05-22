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

  // Handle text selection — uses pointerup so it fires on both mouse and touch.
  useEffect(() => {
    function handlePointerUp(e: PointerEvent) {
      // Ignore right-click and middle-click on desktop.
      if (e.button > 0) return;
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

    document.addEventListener("pointerup", handlePointerUp as EventListener);
    return () => document.removeEventListener("pointerup", handlePointerUp as EventListener);
  }, []);

  return {
    selectionPopup,
    setSelectionPopup,
    selectionEditor,
    setSelectionEditor,
  };
}
