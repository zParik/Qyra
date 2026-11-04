import { describe, expect, it } from "vitest";
import { PT_TO_CSS, TOP_PAD, PAGE_GAP, SIDE_PAD, buildLayout, slotAt, visibleRange, anchorY, fitWidthZoom, snapToDevice, pageBoxLeft } from "./layout";

const LETTER = { w: 612, h: 792 };
const LAND = { w: 792, h: 612 };

describe("buildLayout", () => {
  it("sizes each page from its own points at zoom", () => {
    const l = buildLayout([LETTER, LAND], 1);
    expect(l.widths).toEqual([612 * PT_TO_CSS, 792 * PT_TO_CSS]);
    expect(l.heights).toEqual([792 * PT_TO_CSS, 612 * PT_TO_CSS]);
    expect(l.tops[0]).toBe(TOP_PAD);
    expect(l.tops[1]).toBe(TOP_PAD + l.heights[0] + PAGE_GAP);
    expect(l.totalH).toBe(TOP_PAD * 2 + l.heights[0] + l.heights[1] + 2 * PAGE_GAP);
    expect(l.maxW).toBe(792 * PT_TO_CSS);
  });
});

describe("slotAt / visibleRange", () => {
  const l = buildLayout([LETTER, LAND, LETTER], 1);
  it("finds the slot containing y", () => {
    expect(slotAt(l, 0)).toBe(0);
    expect(slotAt(l, l.tops[1] + 1)).toBe(1);
    expect(slotAt(l, 1e9)).toBe(2);
  });
  it("returns the buffered window", () => {
    expect(visibleRange(l, l.tops[1], 10, 0)).toEqual([1, 1]);
    expect(visibleRange(l, l.tops[1], 10, 1)).toEqual([0, 2]);
  });
});

describe("anchorY", () => {
  it("keeps the same relative point of the same slot", () => {
    const a = buildLayout([LETTER, LETTER], 1);
    const b = buildLayout([LETTER, LETTER], 2);
    const y = a.tops[1] + a.slotHeights[1] / 2;
    expect(anchorY(a, b, y)).toBeCloseTo(b.tops[1] + b.slotHeights[1] / 2);
  });
});

describe("fitWidthZoom", () => {
  it("fits the widest page inside the side padding", () => {
    expect(fitWidthZoom([LETTER, LAND], 792 * PT_TO_CSS + 64)).toBeCloseTo(1);
  });
});

describe("device-pixel snapping", () => {
  it("snaps CSS coordinates onto the 1/dpr grid", () => {
    expect(snapToDevice(10.3, 1)).toBe(10);
    expect(snapToDevice(10.3, 2)).toBe(10.5);
    expect(snapToDevice(10.2, 1.5) * 1.5).toBe(Math.round(10.2 * 1.5));
  });
  it("centres the page box on a device pixel, never left of the side padding", () => {
    expect(pageBoxLeft(1001, 500, 1)).toBe(250); // 250.5 → 250 on a 1px grid
    expect(pageBoxLeft(1001, 500, 2)).toBe(250.5);
    expect(pageBoxLeft(400, 900, 1)).toBe(SIDE_PAD);
  });
});
