import { memo, useEffect, useRef } from "react";
import { base64ToBlob, canvasBackingSize } from "./render/pageBitmap";

interface Props {
  /** Base64 JPEG (data-URL or raw) for the page, or undefined while it renders. */
  src: string | undefined;
  /** Unscaled page-content width in CSS px (zoom is a GPU transform on the parent). */
  cssWidth: number;
  /** Page height / width. Drives the canvas aspect and the placeholder box. */
  aspect: number;
  /** Page number — for the placeholder label + a11y. */
  pageLabel: number;
  /** Red selection outline (remove-pages mode). */
  isSelected?: boolean;
}

/**
 * Renders a single PDF page onto a <canvas>.
 *
 * Why canvas instead of `<img src="data:…">`: the WebView keeps the *decoded*
 * RGBA bitmap of every mounted <img> in an image cache that JS cannot evict, so
 * scrolling/zooming a large document accumulated decoded bitmaps until it OOM-
 * crashed. Here we decode the base64 into an ImageBitmap, blit it into a canvas
 * whose backing store is pinned to the on-screen display size, then `close()` the
 * bitmap immediately. The only pixels that persist are the (bounded) canvas
 * backing store, and unmounting the canvas — which happens automatically when the
 * page scrolls out of the virtual-scroll window — frees them at once.
 */
function PageCanvasInner({ src, cssWidth, aspect, pageLabel, isSelected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return;

    let cancelled = false;
    let bitmap: ImageBitmap | null = null;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvasBackingSize(cssWidth, aspect, dpr);

    (async () => {
      try {
        const blob = base64ToBlob(src);
        // Decode DIRECTLY to the on-screen size. Decoding the full clamped raster
        // (up to MAX_RENDER_DIM) and scaling down on draw allocates a much larger
        // native RGBA bitmap; resizing during decode keeps each decode bounded to
        // what's actually shown, so a burst of decodes can't spike native RAM.
        bitmap = await createImageBitmap(blob, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: "high",
        });
        if (cancelled || !canvasRef.current) {
          bitmap.close();
          return;
        }
        // Size the backing store to the display size (not the source raster) so a
        // page's memory cost is bounded regardless of how large it was rendered.
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(bitmap, 0, 0, width, height);
        }
      } catch {
        // Decode failures fall back to the placeholder (canvas stays blank).
      } finally {
        // Free the decoded pixels immediately — the canvas now owns the only copy.
        bitmap?.close();
        bitmap = null;
      }
    })();

    return () => {
      cancelled = true;
      bitmap?.close();
      // Free the backing store immediately. Zoom re-anchors scroll every step,
      // churning the virtual-scroll window, so pages unmount/remount rapidly;
      // relying on GC of the detached <canvas> let native bitmap memory pile
      // into the gigabytes. `canvas` here is the live element (this effect only
      // runs once src/canvas exist), unlike a mount-time [] effect that captures
      // null because the canvas isn't created until src arrives.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [src, cssWidth, aspect]);

  if (!src) {
    return (
      <div
        className="rounded flex flex-col items-center justify-center gap-2"
        style={{
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
    );
  }

  return (
    <canvas
      ref={canvasRef}
      aria-label={`Page ${pageLabel}`}
      className="w-full rounded shadow-2xl block"
      style={{
        height: "auto",
        display: "block",
        userSelect: "none",
        WebkitUserSelect: "none",
        pointerEvents: "none",
        ...(isSelected ? { outline: "3px solid #ef4444", borderRadius: "0.5rem" } : {}),
      }}
    />
  );
}

// Memoized: the cached `src` data-URL string is referentially stable, so this
// only redraws when the page's raster actually changes (or it gets selected).
export const PageCanvas = memo(PageCanvasInner);
