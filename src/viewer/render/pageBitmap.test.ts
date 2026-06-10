import { describe, it, expect } from "vitest";
import { stripDataUrlPrefix, base64ToBlob, canvasBackingSize } from "./pageBitmap";

describe("stripDataUrlPrefix", () => {
  it("strips a data-URL prefix", () => {
    expect(stripDataUrlPrefix("data:image/jpeg;base64,aGk=")).toBe("aGk=");
  });
  it("leaves raw base64 untouched", () => {
    expect(stripDataUrlPrefix("aGk=")).toBe("aGk=");
  });
  it("does not treat a plain comma-containing string as a data URL", () => {
    expect(stripDataUrlPrefix("a,b")).toBe("a,b");
  });
});

describe("base64ToBlob", () => {
  it("decodes to the original byte length", async () => {
    // "hi" => "aGk="
    const blob = await base64ToBlob("aGk=");
    expect(blob.size).toBe(2);
    expect(blob.type).toBe("image/jpeg");
  });
  it("accepts a full data URL", async () => {
    const blob = await base64ToBlob("data:image/jpeg;base64,aGk=");
    expect(blob.size).toBe(2);
  });
  it("honors an explicit mime type", async () => {
    const blob = await base64ToBlob("aGk=", "image/png");
    expect(blob.type).toBe("image/png");
  });
});

describe("canvasBackingSize", () => {
  it("scales CSS width by dpr and derives height from aspect", () => {
    const { width, height } = canvasBackingSize(768, 1.4142, 1, { maxDim: 100000 });
    expect(width).toBe(768);
    expect(height).toBe(Math.round(768 * 1.4142));
  });

  it("multiplies by dpr up to the cap", () => {
    expect(canvasBackingSize(768, 1, 2, { maxDim: 100000 }).width).toBe(1536);
  });

  it("clamps dpr to maxDpr (default 2)", () => {
    expect(canvasBackingSize(768, 1, 4, { maxDim: 100000 }).width).toBe(1536);
  });

  it("never goes below dpr 1", () => {
    expect(canvasBackingSize(768, 1, 0.5, { maxDim: 100000 }).width).toBe(768);
  });

  it("caps the longest edge at maxDim, preserving aspect", () => {
    // tall page: height is the longest edge
    const { width, height } = canvasBackingSize(2000, 2, 2, { maxDim: 2600 });
    expect(Math.max(width, height)).toBeLessThanOrEqual(2600);
    // aspect (height/width) stays ~2
    expect(height / width).toBeCloseTo(2, 1);
  });

  it("returns at least 1x1", () => {
    const { width, height } = canvasBackingSize(0, 0, 0);
    expect(width).toBeGreaterThanOrEqual(1);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});
