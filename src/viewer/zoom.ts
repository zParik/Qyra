// Pure zoom math, extracted from the Viewer so it can be unit-tested and so the
// ctrl+wheel handler can batch a frame's worth of events into one update.

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3.0;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
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
