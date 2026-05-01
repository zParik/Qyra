import { useEffect, useRef } from "react";
import { TextLayer as PdfjsTextLayer } from "pdfjs-dist";
import { loadDocument } from "../hooks/usePageThumbnails";

interface TextLayerProps {
  pdfPath: string;
  pageNum: number;
  /** Current zoom level — used as a dep to re-measure parent width on zoom change */
  zoom: number;
  findQuery?: string;
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
export function TextLayer({ pdfPath, pageNum, zoom, findQuery, isDrawingMode, enabled = true }: TextLayerProps) {
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
        // in setLayerDimensions() to compute width/height via calc(). Without it
        // the container collapses to 0×0 and all text spans pile at (0,0).
        // We set it to 1 because our viewport is already at the correct scale.
        el.style.setProperty("--total-scale-factor", "1");
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

        // Highlight spans matching the find query
        if (findQuery?.trim() && !cancelled) {
          const q = findQuery.trim().toLowerCase();
          el.querySelectorAll<HTMLElement>("span").forEach((span) => {
            if (span.textContent?.toLowerCase().includes(q)) {
              span.classList.add("find-highlight");
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
  }, [pdfPath, pageNum, zoom, findQuery, enabled]);

  return (
    <div
      ref={ref}
      className="textLayer"
      style={{ pointerEvents: isDrawingMode ? "none" : "auto" }}
    />
  );
}
