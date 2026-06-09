// Pure zoom math, extracted from the Viewer so it can be unit-tested and so the
// ctrl+wheel handler can batch a frame's worth of events into one update.

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3.0;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Default zoom granularity for wheel/pinch — see {@link snapZoom}. */
export const ZOOM_STEP = 0.1;

/**
 * Snap a zoom value to a coarse ladder (multiples of `step`, clamped to range).
 *
 * Wheel and pinch zoom are multiplicative and continuous, so they emit a new,
 * never-before-seen scale on every animation frame. The WebView software-
 * composites each page's layer (canvas + text + shadow) into system RAM and
 * caches a raster keyed by scale, so a stream of unique scales made that cache
 * climb to ~18 GB during zoom-spam (the GPU never moved — it is not GPU-bound).
 * Snapping to a fixed ladder means spam can only ever produce a handful of
 * distinct scales, so the cached rasters are reused and memory plateaus.
 */
export function snapZoom(z: number, step = ZOOM_STEP): number {
  return clampZoom(Math.round(z / step) * step);
}

/**
 * Next zoom level from accumulated wheel deltaY.
 *
 * The factor is `0.999^deltaY`, which is multiplicative, so a frame's worth of
 * wheel events can be summed and applied in a single call — the result is
 * identical to applying each event in turn. This is what lets the handler
 * coalesce a burst of events into one `setZoom` per animation frame.
 *
 * `fitZoom` is the zoom at which the page exactly fills the container. When a
 * step crosses *into* the snap zone around it (but only from outside), the
 * result is magneted to `fitZoom` so fit-width is easy to land on.
 */
export function nextZoomFromWheel(prev: number, deltaY: number, fitZoom: number): number {
  const next = clampZoom(prev * Math.pow(0.999, deltaY));
  const inZone = (z: number) => Math.abs(z - fitZoom) < fitZoom * 0.04;
  if (!inZone(prev) && inZone(next)) return fitZoom;
  return next;
}
