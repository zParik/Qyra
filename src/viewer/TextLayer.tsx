import { useEffect, useRef } from "react";
import { TextLayer as PdfjsTextLayer } from "pdfjs-dist";
import { loadDocument } from "../hooks/usePageThumbnails";

interface TextLayerProps {
  pdfPath: string;
  pageNum: number;
  /** Current zoom level — used as a dep to re-measure parent width on zoom change */
  zoom: number;
  findQuery?: string;
  /**
   * 0-based index of the current find match among matches on this page (same order
   * as document-wide find). Use -1 when no match on this page is current.
   */
  findActiveMatchOrdinal?: number;
  isDrawingMode?: boolean;
  enabled?: boolean;
}

/**
 * Renders a PDF.js text layer over a page image, enabling text selection and
 * find-in-document highlighting.
 *
 * Must be placed inside a `position: relative` container that is sized to match
 * the displayed page image.
 */
export function TextLayer({
  pdfPath,
  pageNum,
  zoom,
  findQuery,
  findActiveMatchOrdinal = -1,
  isDrawingMode,
  enabled = true,
}: TextLayerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled) {
      el.innerHTML = "";
      return;
    }

    let cancelled = false;
    let renderTask: PdfjsTextLayer | null = null;

    async function go() {
      if (!el) return;
      try {
        const doc = await loadDocument(pdfPath);
        if (cancelled) return;

        const page = await doc.getPage(pageNum);
        if (cancelled) return;

        // Measure the actual displayed width of the page container.
        // useEffect runs after paint so the DOM already reflects the current zoom.
        const parentWidth = el.parentElement?.clientWidth ?? el.clientWidth;
        if (!parentWidth) return;

        const naturalViewport = page.getViewport({ scale: 1 });
        const scale = parentWidth / naturalViewport.width;
        const viewport = page.getViewport({ scale });

        el.innerHTML = "";

        // pdfjs-dist v5 TextLayer uses CSS custom property --total-scale-factor
        // in setLayerDimensions() to compute width/height via calc().
        // We set it to the actual viewport scale so the DOM font sizes perfectly
        // match the zoomed canvas text, aligning selection boxes and highlights.
        el.style.setProperty("--total-scale-factor", scale.toString());
        // Also set rounding vars that pdfjs may reference
        el.style.setProperty("--scale-round-x", "1px");
        el.style.setProperty("--scale-round-y", "1px");

        const textContent = await page.getTextContent({ includeMarkedContent: true });
        if (cancelled) return;

        // PDF text items are often out of visual order in the DOM, which causes
        // native text selection to warp and select unrelated paragraphs.
        // Sorting them by visual position (Y descending, X ascending) fixes this.
        textContent.items.sort((a: any, b: any) => {
          if (!a.transform || !b.transform) return 0;
          const yA = a.transform[5];
          const yB = b.transform[5];
          // If items are on different lines (difference > 5 units), sort top-to-bottom
          if (Math.abs(yA - yB) > 5) {
            return yB - yA; // Higher Y means visually higher on the page
          }
          // If on the same line, sort left-to-right
          return a.transform[4] - b.transform[4];
        });

        const task = new PdfjsTextLayer({
          textContentSource: textContent,
          container: el,
          viewport,
        });
        renderTask = task;
        await task.render();

        // pdfjs setLayerDimensions sets explicit width/height using calc(),
        // but we want the layer to fill its parent (already correctly sized
        // by the page image). Override to 100% so percentage-based span
        // positions align with the displayed page.
        el.style.width = "100%";
        el.style.height = "100%";

        // Highlight text, supporting cross-span matches and split words
        if (findQuery?.trim() && !cancelled) {
          const q = findQuery.trim().toLowerCase();
          
          // Get all leaf spans in visual order
          const spans = Array.from(el.querySelectorAll<HTMLElement>("span")).filter(s => s.children.length === 0);
          
          let fullText = "";
          const spanStarts: number[] = [];
          
          spans.forEach(span => {
            spanStarts.push(fullText.length);
            fullText += span.textContent ?? "";
          });
          
          const lowerFull = fullText.toLowerCase();
          const matches: {start: number, end: number}[] = [];
          let idx = 0;
          while ((idx = lowerFull.indexOf(q, idx)) !== -1) {
            matches.push({ start: idx, end: idx + q.length });
            idx += q.length; // Move past the matched string
          }
          
          const layerRect = el.getBoundingClientRect();
          if (layerRect.width === 0 || layerRect.height === 0) return;

          const highlightContainer = document.createElement("div");
          highlightContainer.className = "find-highlight-container";
          highlightContainer.style.position = "absolute";
          highlightContainer.style.inset = "0";
          highlightContainer.style.pointerEvents = "none";
          highlightContainer.style.zIndex = "0";
          el.appendChild(highlightContainer);

          const activeOrdinal =
            findActiveMatchOrdinal >= 0 && findActiveMatchOrdinal < matches.length
              ? findActiveMatchOrdinal
              : -1;

          const appendHighlightRects = (
            span: HTMLElement,
            hl: { start: number; end: number },
            matchIdx: number
          ) => {
            const textNode = Array.from(span.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
            if (!textNode) return;
            const range = document.createRange();
            try {
              range.setStart(textNode, hl.start);
              range.setEnd(textNode, hl.end);
              const rects = range.getClientRects();
              const isActive = matchIdx === activeOrdinal;
              for (let r = 0; r < rects.length; r++) {
                const rect = rects[r];
                const div = document.createElement("div");
                div.className = isActive ? "find-highlight-active" : "find-highlight";
                div.style.position = "absolute";
                div.style.left = `${((rect.left - layerRect.left) / layerRect.width) * 100}%`;
                div.style.top = `${((rect.top - layerRect.top) / layerRect.height) * 100}%`;
                div.style.width = `${(rect.width / layerRect.width) * 100}%`;
                div.style.height = `${(rect.height / layerRect.height) * 100}%`;
                div.style.padding = "1px 0";
                div.style.marginTop = "-1px";
                if (isActive) div.style.zIndex = "1";
                highlightContainer.appendChild(div);
              }
            } catch {
              /* offsets out of bounds */
            }
          };

          matches.forEach((match, matchIdx) => {
            for (let i = 0; i < spans.length; i++) {
              const spanStart = spanStarts[i];
              const spanLen = (spans[i].textContent ?? "").length;
              const spanEnd = spanStart + spanLen;

              if (match.end <= spanStart) break;
              if (match.start >= spanEnd) continue;

              const overlapStart = Math.max(0, match.start - spanStart);
              const overlapEnd = Math.min(spanLen, match.end - spanStart);
              appendHighlightRects(spans[i], { start: overlapStart, end: overlapEnd }, matchIdx);
            }
          });
        }
      } catch {
        // Render errors are non-fatal; the page image is still visible
      }
    }

    go();

    return () => {
      cancelled = true;
      if (renderTask) {
        try { renderTask.cancel(); } catch { /* cancelled render throws, ignore */ }
      }
    };
  }, [pdfPath, pageNum, zoom, findQuery, findActiveMatchOrdinal, enabled]);

  return (
    <div
      ref={ref}
      className="textLayer"
      style={{ pointerEvents: isDrawingMode ? "none" : "auto" }}
    />
  );
}
