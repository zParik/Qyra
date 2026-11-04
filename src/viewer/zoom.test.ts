import { describe, it, expect } from "vitest";
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, clampZoom, commitZoom, nextZoomFromWheel, snapZoom } from "./zoom";

describe("clampZoom", () => {
  it("clamps below the minimum", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
  });
  it("clamps above the maximum", () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX);
  });
  it("allows 10% to 1600% zoom", () => {
    expect(ZOOM_MIN).toBe(0.1);
    expect(ZOOM_MAX).toBe(16);
    expect(clampZoom(20)).toBe(16);
    expect(clampZoom(0.01)).toBe(0.1);
  });
  it("passes through in-range values", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe("nextZoomFromWheel", () => {
  const noFit = -1; // a fitZoom that can never be entered, disables the magnet

  it("zooms in on negative deltaY (scroll up)", () => {
    expect(nextZoomFromWheel(1.0, -100, noFit)).toBeGreaterThan(1.0);
  });

  it("zooms out on positive deltaY (scroll down)", () => {
    expect(nextZoomFromWheel(1.0, 100, noFit)).toBeLessThan(1.0);
  });

  it("never exceeds the bounds", () => {
    expect(nextZoomFromWheel(ZOOM_MAX, -100000, noFit)).toBe(ZOOM_MAX);
    expect(nextZoomFromWheel(ZOOM_MIN, 100000, noFit)).toBe(ZOOM_MIN);
  });

  // Coalescing correctness: because the factor is 0.999^deltaY (multiplicative),
  // summing the deltas of several wheel events and applying them once must equal
  // applying each event sequentially. This is what lets the handler batch a
  // frame's worth of events into a single setZoom without changing the result.
  it("is additive in deltaY (batching one frame == applying each event)", () => {
    const sequential = nextZoomFromWheel(
      nextZoomFromWheel(1.0, 30, noFit),
      40,
      noFit,
    );
    const batched = nextZoomFromWheel(1.0, 70, noFit);
    expect(batched).toBeCloseTo(sequential, 10);
  });

  it("snaps to fitZoom when crossing into the magnet zone", () => {
    const fitZoom = 1.3;
    // prev sits outside the zone, next lands inside → snap exactly to fitZoom
    const next = nextZoomFromWheel(1.0, -260, fitZoom);
    expect(next).toBe(fitZoom);
  });

  it("does not snap when already inside the magnet zone", () => {
    const fitZoom = 1.3;
    const next = nextZoomFromWheel(fitZoom, -1, fitZoom);
    expect(next).not.toBe(fitZoom);
  });
});

describe("snapZoom", () => {
  it("snaps to the nearest ladder step", () => {
    expect(snapZoom(1.04)).toBeCloseTo(1.0, 10);
    expect(snapZoom(1.06)).toBeCloseTo(1.1, 10);
  });

  it("clamps to the zoom range", () => {
    expect(snapZoom(0.01)).toBe(ZOOM_MIN);
    expect(snapZoom(99)).toBe(ZOOM_MAX);
  });

  it("produces only a bounded set of distinct values across the range", () => {
    // Continuous input → a small, fixed set of outputs, so a gesture only ever
    // requests tiles at a bounded number of render scales.
    const seen = new Set<number>();
    for (let z = ZOOM_MIN; z <= ZOOM_MAX; z += 0.001) {
      seen.add(Math.round(snapZoom(z) * 1000)); // round to kill float noise
    }
    expect(seen.size).toBeLessThanOrEqual(Math.ceil((ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP) + 2);
  });

  it("is idempotent on values already on the ladder", () => {
    expect(snapZoom(snapZoom(1.37))).toBeCloseTo(snapZoom(1.37), 10);
  });
});

describe("commitZoom", () => {
  const noFit = -1;

  // A small gesture used to snap straight back to the zoom it started from, so the
  // committed zoom never changed and the gesture's preview transform was left on
  // the pages, resampling every tile (blurry text after zooming out).
  it("moves at least one rung when a small zoom-out would snap back", () => {
    expect(commitZoom(0.97, 1.0, noFit)).toBeCloseTo(0.9, 10);
    expect(commitZoom(0.27, 0.3, noFit)).toBeCloseTo(0.2, 10);
  });

  it("moves at least one rung when a small zoom-in would snap back", () => {
    expect(commitZoom(1.03, 1.0, noFit)).toBeCloseTo(1.1, 10);
  });

  it("snaps normally when the gesture already reaches another rung", () => {
    expect(commitZoom(0.82, 1.0, noFit)).toBeCloseTo(0.8, 10);
  });

  it("keeps the fit-width zoom exactly", () => {
    expect(commitZoom(1.234, 1.0, 1.234)).toBe(1.234);
  });

  it("stays put at the range limits", () => {
    expect(commitZoom(ZOOM_MIN, ZOOM_MIN, noFit)).toBe(ZOOM_MIN);
    expect(commitZoom(ZOOM_MAX, ZOOM_MAX, noFit)).toBe(ZOOM_MAX);
  });

  it("returns the current zoom when the gesture did not move", () => {
    expect(commitZoom(1.0, 1.0, noFit)).toBe(1.0);
  });
});
