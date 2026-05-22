import { useEffect, useRef, useState } from "react";
import type { RedactRegion } from "./tools/RedactPanel";

export type { RedactRegion };

interface Props {
  pageNum: number;
  isEnabled: boolean;
  mode: "region" | "text";
  regions: RedactRegion[];
  onAddRegion: (r: RedactRegion) => void;
  onAddRegions: (rs: RedactRegion[]) => void;
  onRemoveRegion: (index: number) => void;
}

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Per-page redact overlay.
 *
 * Two interaction modes:
 *   - "region": user drags a rectangle on this overlay; on mouse-up the
 *     normalized rect is added as a redact region.
 *   - "text": this overlay disables its own pointer-events so the underlying
 *     TextLayer receives the selection. On window mouse-up, we read the
 *     active Selection, walk its client rects, keep those that intersect this
 *     layer's bounding rect, normalize them into the page, and emit them as
 *     redact regions in one batch (per page). The browser's text selection is
 *     then cleared so the next drag starts fresh.
 *
 * Existing regions for this page are rendered as solid-black overlays — the
 * preview matches the final destructive output (the underlying region is
 * deleted on export, not just covered by translucency).
 */
export function RedactLayer({
  pageNum,
  isEnabled,
  mode,
  regions,
  onAddRegion,
  onAddRegions,
  onRemoveRegion,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Text-mode capture: scrape current selection on mouse-up, intersect with
  // this layer's rect, emit any covered lines as redact regions.
  useEffect(() => {
    if (!isEnabled || mode !== "text") return;
    function onUp() {
      const layer = layerRef.current;
      if (!layer) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const layerRect = layer.getBoundingClientRect();
      if (layerRect.width <= 0 || layerRect.height <= 0) return;

      const captured: RedactRegion[] = [];
      for (let ri = 0; ri < sel.rangeCount; ri++) {
        const range = sel.getRangeAt(ri);
        const rects = range.getClientRects();
        for (const r of Array.from(rects)) {
          // Only keep rects whose center lies inside this page's layer — this
          // is how we attribute selection rects to the right page when a
          // selection spans multiple pages.
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (
            cx < layerRect.left ||
            cx > layerRect.right ||
            cy < layerRect.top ||
            cy > layerRect.bottom
          )
            continue;
          if (r.width <= 0.5 || r.height <= 0.5) continue;

          const x0 = (r.left - layerRect.left) / layerRect.width;
          const y0 = (r.top - layerRect.top) / layerRect.height;
          const x1 = (r.right - layerRect.left) / layerRect.width;
          const y1 = (r.bottom - layerRect.top) / layerRect.height;

          // Pad redaction by ~1px on each side (in normalized space) so glyph
          // edges aren't missed by MuPDF's intersection test on the backend.
          const padX = 1 / layerRect.width;
          const padY = 1 / layerRect.height;

          captured.push({
            page: pageNum,
            x0: Math.max(0, Math.min(1, x0 - padX)),
            y0: Math.max(0, Math.min(1, y0 - padY)),
            x1: Math.max(0, Math.min(1, x1 + padX)),
            y1: Math.max(0, Math.min(1, y1 + padY)),
          });
        }
      }

      if (captured.length > 0) {
        onAddRegions(captured);
        // Clear the selection so subsequent drags don't re-capture the same
        // range, and so other pages' layers don't double-process.
        sel.removeAllRanges();
      }
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [isEnabled, mode, pageNum, onAddRegions]);

  function pointFromEvent(e: React.MouseEvent): { x: number; y: number } | null {
    const el = layerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function onMouseDown(e: React.MouseEvent) {
    if (!isEnabled || mode !== "region" || e.button !== 0) return;
    const p = pointFromEvent(e);
    if (!p) return;
    e.preventDefault();
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!drag) return;
    const p = pointFromEvent(e);
    if (!p) return;
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }

  function onMouseUp() {
    if (!drag) return;
    const x0 = Math.min(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1);
    const x1 = Math.max(drag.x0, drag.x1);
    const y1 = Math.max(drag.y0, drag.y1);
    setDrag(null);
    if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return;
    onAddRegion({ page: pageNum, x0, y0, x1, y1 });
  }

  function onMouseLeave() {
    if (drag) setDrag(null);
  }

  if (!isEnabled && regions.length === 0) return null;

  const pageRegions = regions
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.page === pageNum);

  const dragRect = drag
    ? {
        left: `${Math.min(drag.x0, drag.x1) * 100}%`,
        top: `${Math.min(drag.y0, drag.y1) * 100}%`,
        width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
        height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
      }
    : null;

  // In text mode the layer must let pointer events through so the TextLayer
  // beneath receives them — but we still need to render the captured-region
  // overlays. The trick: outer container is pointer-events: none in text mode,
  // and individual region overlays opt back in to pointer-events when the
  // tool is enabled so the × remove button stays clickable.
  const containerPointerEvents = isEnabled
    ? mode === "text"
      ? "none"
      : "auto"
    : "none";

  return (
    <div
      ref={layerRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 14,
        cursor: isEnabled && mode === "region" ? "crosshair" : "default",
        pointerEvents: containerPointerEvents,
        userSelect: mode === "text" ? "auto" : "none",
      }}
    >
      {pageRegions.map(({ r, idx }) => {
        const w = r.x1 - r.x0;
        const h = r.y1 - r.y0;
        return (
          <div
            key={idx}
            style={{
              position: "absolute",
              left: `${r.x0 * 100}%`,
              top: `${r.y0 * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              background: "#000",
              border: "1px solid rgba(255, 0, 0, 0.9)",
              boxSizing: "border-box",
              pointerEvents: isEnabled ? "auto" : "none",
            }}
          >
            {isEnabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveRegion(idx);
                }}
                title="Remove redact region"
                style={{
                  position: "absolute",
                  top: -10,
                  right: -10,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: "1px solid rgba(255,255,255,0.4)",
                  background: "rgba(220, 38, 38, 0.95)",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {dragRect && (
        <div
          style={{
            position: "absolute",
            ...dragRect,
            background: "rgba(0, 0, 0, 0.45)",
            border: "1.5px dashed rgba(255, 0, 0, 0.95)",
            pointerEvents: "none",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}
