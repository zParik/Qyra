import { memo, useEffect, useRef, useState } from "react";
import { base64ToBlob } from "./render/pageBitmap";

interface Props {
  /**
   * Base64 JPEG (data-URL) for the page, already rendered at the CURRENT zoom's
   * target resolution, or undefined while it (re-)renders. When it goes undefined
   * mid-zoom we keep the last frame on screen — we never blank the canvas.
   */
  src: string | undefined;
  /**
   * Document-nominal height/width ratio — used ONLY by the pre-first-frame
   * placeholder to reserve approximate space. It never sizes the canvas or its
   * backing: once the first frame lands, the bitmap's true aspect drives layout.
   */
  aspect: number;
  /** Page number — placeholder label + a11y. */
  pageLabel: number;
  /** Red selection outline (remove-pages mode). */
  isSelected?: boolean;
}

/**
 * Renders a single PDF page onto a <canvas>, double-buffered.
 *
 * The page bitmap is rendered (by MuPDF, in Rust) at the resolution of the CURRENT
 * zoom — so the canvas backing store equals the decoded bitmap's native size and is
 * displayed ~1:1. There is no CSS transform/zoom scaling the canvas, so the WebView
 * never caches a per-scale raster tile-set in (software-composited) system RAM — that
 * cache was the multi-GB zoom-spam blowup.
 *
 * Double-buffering = no flicker: the previous frame stays on the canvas while the new
 * bitmap decodes; only once it's fully decoded do we resize the backing + blit, in one
 * synchronous block, so the cleared state is never painted. On a zoom change the old
 * (lower-res) frame is simply CSS-scaled to the new display size for the ~100 ms until
 * the crisp render lands — a soft frame, never a blank one. We deliberately do NOT
 * clear on src→undefined (the page being momentarily pruned from the render window).
 *
 * Unmounting the canvas (page scrolled out of the virtual window) frees the backing
 * store immediately, so total bitmap memory stays bounded to the visible window.
 */
function PageCanvasInner({ src, aspect, pageLabel, isSelected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  // The src whose pixels currently fill the backing. Lets a page that left the active
  // band (src → undefined, frame frozen) re-sync for free when the SAME render comes
  // back: identical cached data-URL + intact backing → skip the decode entirely.
  const drawnSrcRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return;
    if (src === drawnSrcRef.current && canvas.width > 0) return;

    let cancelled = false;
    let bitmap: ImageBitmap | null = null;

    (async () => {
      try {
        // Decode through a Blob, NOT `new Image(src)`. A loaded HTMLImageElement
        // leaves its decoded RGBA bitmap in the WebView's image cache, keyed by URL
        // and unevictable from JS — and render-at-zoom mints a new data-URL every
        // zoom step, so that cache balloons to many GB. createImageBitmap(blob)
        // decodes into an ImageBitmap we own and close() immediately: nothing
        // persists but the (bounded) canvas backing store.
        const blob = await base64ToBlob(src);
        if (cancelled && canvas.width > 0) return;
        // Native size — no resize. The render already targets the current zoom.
        bitmap = await createImageBitmap(blob);
        // A cancelled decode still completes IF the canvas has no frame yet — a
        // slightly-stale first frame beats a spinner when src is briefly withheld
        // (fling gate). With a frame already present, stale results are discarded.
        if (!canvasRef.current || (cancelled && canvas.width > 0)) {
          bitmap.close();
          bitmap = null;
          return;
        }

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        // Atomic swap: decode is already done, so resizing the backing (which clears
        // it) and blitting happen in one synchronous block — the blank is never painted.
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        drawnSrcRef.current = src;
        if (!ready) setReady(true);
      } catch {
        // Decode failed — keep whatever frame is already on the canvas.
      } finally {
        bitmap?.close();
        bitmap = null;
      }
    })();

    // Cleanup on src change only cancels the in-flight decode. It must NOT clear the
    // canvas — keeping the old frame is what makes zoom flicker-free.
    return () => {
      cancelled = true;
      bitmap?.close();
      bitmap = null;
    };
  }, [src]);

  // Free the backing store when the page scrolls out of the window (unmount only).
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  return (
    <>
      {/* The canvas is hidden (not unmounted — its backing must survive for the
          double-buffer) until the first frame lands. Once visible, `w-full h-auto`
          means its TRUE bitmap aspect sets the page box height, so every overlay
          layer (inset:0 of the shrink-wrapped parent) aligns with the glyphs. */}
      <canvas
        ref={canvasRef}
        aria-label={`Page ${pageLabel}`}
        className="w-full block"
        style={{
          height: "auto",
          display: ready ? "block" : "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          pointerEvents: "none",
          borderRadius: "0.25rem",
          // Cheap shadow instead of Tailwind shadow-2xl: a large blur is an expensive
          // software raster (no GPU here) that scales with page area.
          boxShadow: "0 1px 3px rgba(0,0,0,0.28), 0 4px 12px rgba(0,0,0,0.22)",
          ...(isSelected ? { outline: "3px solid #ef4444" } : {}),
        }}
      />
      {!ready && (
        <div
          className="rounded flex flex-col items-center justify-center gap-2"
          style={{
            // In-flow (not absolute) so it reserves the page box pre-first-frame,
            // using the nominal aspect as an estimate until the bitmap arrives.
            aspectRatio: `1/${aspect}`,
            background: "color-mix(in oklch, var(--viewer-elevated) 60%, transparent)",
            border: isSelected ? "3px solid #ef4444" : "1px solid var(--viewer-border-sub)",
          }}
        >
          <svg className="w-6 h-6 animate-spin" style={{ color: "var(--viewer-text-muted)" }} fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>Page {pageLabel}</span>
        </div>
      )}
    </>
  );
}

// Memoized: redraws only when the page's raster (src) or display size changes.
export const PageCanvas = memo(PageCanvasInner);
