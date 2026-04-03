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
}

/**
 * Renders a PDF.js text layer over a page image, enabling text selection and
 * find-in-document highlighting.
 *
 * Must be placed inside a `position: relative` container that is sized to match
 * the displayed page image.
 */
export function TextLayer({ pdfPath, pageNum, zoom, findQuery, isDrawingMode }: TextLayerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let renderTask: PdfjsTextLayer | null = null;

    async function go() {
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

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const task = new PdfjsTextLayer({
          textContentSource: textContent,
          container: el,
          viewport,
        });
        renderTask = task;
        await task.render();

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
        // Cancelled render tasks throw — ignore silently
      }
    }

    go();

    return () => {
      cancelled = true;
      if (renderTask) {
        try { renderTask.cancel(); } catch { /* cancelled render throws, ignore */ }
      }
    };
  }, [pdfPath, pageNum, zoom, findQuery]);

  return (
    <div
      ref={ref}
      className="textLayer"
      style={{ pointerEvents: isDrawingMode ? "none" : "auto" }}
    />
  );
}
