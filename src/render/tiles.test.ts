import { describe, expect, it } from "vitest";
import { TILE, renderScale, pagePx, tilesInRect, tileRectPx } from "./tiles";

describe("tiles", () => {
  it("renderScale = zoom * 96/72 * dpr", () => {
    expect(renderScale(1, 1)).toBeCloseTo(96 / 72);
    expect(renderScale(2, 1.5)).toBeCloseTo(4);
  });
  it("pagePx matches Rust page_px (ceil with epsilon)", () => {
    expect(pagePx({ w: 612, h: 792 }, 96 / 72)).toEqual({ w: 816, h: 1056 });
    expect(pagePx({ w: 10.1, h: 10 }, 1)).toEqual({ w: 11, h: 10 });
    expect(pagePx({ w: 612, h: 792 }, 0.0001)).toEqual({ w: 1, h: 1 });
  });
  it("tilesInRect returns tiles intersecting the rect, clamped to the grid", () => {
    const px = { w: 816, h: 1056 };
    expect(tilesInRect(px, { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([{ tx: 0, ty: 0 }]);
    expect(tilesInRect(px, { x0: 500, y0: 500, x1: 600, y1: 600 })).toEqual([
      { tx: 0, ty: 0 }, { tx: 1, ty: 0 }, { tx: 0, ty: 1 }, { tx: 1, ty: 1 },
    ]);
    expect(tilesInRect(px, { x0: -1000, y0: -1000, x1: 1e6, y1: 1e6 })).toHaveLength(6);
    expect(tilesInRect(px, { x0: 2000, y0: 0, x1: 3000, y1: 10 })).toEqual([]);
  });
  it("tileRectPx clips the last tile", () => {
    expect(tileRectPx({ w: 816, h: 1056 }, { tx: 1, ty: 2 })).toEqual({ x0: TILE, y0: 2 * TILE, x1: 816, y1: 1056 });
  });
});
