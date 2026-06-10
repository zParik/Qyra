// Page-raster helpers for the canvas render surface.
//
// The viewer used to mount each page as `<img src="data:image/jpeg;base64,…">`.
// The WebView then held the *decoded* RGBA bitmap in an image cache we cannot
// evict from JS, so scrolling/zooming a large document (especially one with
// oversized pages) piled up decoded bitmaps until RAM was exhausted. Drawing the
// page onto a <canvas> instead lets us decode once into an ImageBitmap, blit it,
// and `close()` the bitmap immediately — the only pixels that persist are the
// canvas backing store, whose size we pin to the on-screen display size.

/** Strip an optional `data:…;base64,` prefix, returning the raw base64 payload. */
export function stripDataUrlPrefix(input: string): string {
  const comma = input.indexOf(",");
  if (input.startsWith("data:") && comma !== -1) return input.slice(comma + 1);
  return input;
}

/**
 * Decode a base64 string (with or without a data-URL prefix) into a Blob.
 * Kept synchronous and dependency-free so it is trivially unit-testable.
 */
export async function base64ToBlob(base64: string, mime = "image/jpeg"): Promise<Blob> {
  const url = base64.startsWith("data:") ? base64 : `data:${mime};base64,${base64}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed");
    return await res.blob();
  } catch {
    // fallback for environments where fetch data: isn't supported (like some JSDOM/Node tests)
    const base64Data = stripDataUrlPrefix(base64);
    const byteString = atob(base64Data);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);

    // Chunk the assignment to avoid blocking the main thread synchronously
    const CHUNK_SIZE = 1048576; // 1MB chunks
    for (let i = 0; i < byteString.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, byteString.length);
      for (let j = i; j < end; j++) {
        ia[j] = byteString.charCodeAt(j);
      }
      if (end < byteString.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return new Blob([ab], { type: mime });
  }
}

/**
 * Compute the canvas backing-store size (device pixels) for a page displayed at
 * `cssWidth` CSS px with the given height/width `aspect`. Pinning the backing
 * store to the *display* size — not the source raster size — bounds the memory a
 * visible page costs regardless of how many pixels the renderer produced: an
 * over-rendered source bitmap is simply scaled down into this box on draw.
 *
 * `dpr` is clamped to [1, maxDpr] so a hostile/huge devicePixelRatio can't blow
 * the budget, and the longest edge is capped at `maxDim` as a final guard.
 */
export function canvasBackingSize(
  cssWidth: number,
  aspect: number,
  dpr: number,
  opts: { maxDpr?: number; maxDim?: number } = {},
): { width: number; height: number } {
  const { maxDpr = 2, maxDim = 2600 } = opts;
  const safeDpr = Math.max(1, Math.min(dpr || 1, maxDpr));
  let width = Math.max(1, Math.round(cssWidth * safeDpr));
  let height = Math.max(1, Math.round(width * aspect));
  const longest = Math.max(width, height);
  if (longest > maxDim) {
    const k = maxDim / longest;
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(height * k));
  }
  return { width, height };
}
