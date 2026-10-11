// Pure page layout for the virtual-scrolling viewer. zoom = 1 → 1 pt = 96/72 CSS px.
export const PT_TO_CSS = 96 / 72;
export const TOP_PAD = 32;
export const SIDE_PAD = 32;
/** Vertical space per slot outside the page box (half above, half below). */
export const PAGE_GAP = 64;

export type PageSize = { w: number; h: number };

export type Layout = {
  /** Slot top (page box top = tops[i] + PAGE_GAP / 2). */
  tops: number[];
  slotHeights: number[];
  widths: number[];
  heights: number[];
  totalH: number;
  maxW: number;
};

export function buildLayout(sizes: PageSize[], zoom: number): Layout {
  const k = PT_TO_CSS * zoom;
  const tops: number[] = [];
  const slotHeights: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = TOP_PAD;
  let maxW = 0;
  for (const s of sizes) {
    const w = s.w * k;
    const h = s.h * k;
    tops.push(y);
    widths.push(w);
    heights.push(h);
    slotHeights.push(h + PAGE_GAP);
    y += h + PAGE_GAP;
    maxW = Math.max(maxW, w);
  }
  return { tops, slotHeights, widths, heights, totalH: y + TOP_PAD, maxW };
}

/** Index of the slot containing content-y (clamped to [0, n-1]). */
export function slotAt(l: Layout, y: number): number {
  let lo = 0;
  let hi = l.tops.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function visibleRange(l: Layout, scrollTop: number, viewportH: number, buffer = 2): [number, number] {
  const n = l.tops.length;
  if (n === 0) return [0, -1];
  const first = Math.max(0, slotAt(l, scrollTop) - buffer);
  const last = Math.min(n - 1, slotAt(l, scrollTop + viewportH) + buffer);
  return [first, last];
}

/** Map content-y in `oldL` to the same relative point of the same slot in `newL`. */
export function anchorY(oldL: Layout, newL: Layout, y: number): number {
  if (oldL.tops.length === 0 || newL.tops.length === 0) return y;
  const i = Math.min(slotAt(oldL, y), newL.tops.length - 1);
  const frac = (y - oldL.tops[i]!) / oldL.slotHeights[i]!;
  return newL.tops[i]! + frac * newL.slotHeights[i]!;
}

/** Zoom at which the widest page fills the container inside SIDE_PAD on both sides. */
export function fitWidthZoom(sizes: PageSize[], containerW: number): number {
  const widest = Math.max(1, ...sizes.map((s) => s.w));
  return Math.max(0.01, (containerW - 2 * SIDE_PAD) / (widest * PT_TO_CSS));
}
