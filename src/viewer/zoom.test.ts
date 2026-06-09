import { describe, it, expect } from "vitest";
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, clampZoom, nextZoomFromWheel, snapZoom } from "./zoom";

describe("clampZoom", () => {
  it("clamps below the minimum", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });
  it("clamps above the maximum", () => {
    expect(clampZoom(9)).toBe(ZOOM_MAX);
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
    // The whole point: continuous input → a small, fixed set of outputs, so the
    // compositor caches a bounded number of per-scale rasters.
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
