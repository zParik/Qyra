import { describe, expect, it } from "vitest";
import { TileCache, tileKey, tileKeyPrefix } from "./tileCache";

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

describe("TileCache", () => {
  it("evicts least-recently-used beyond the byte budget and frees the canvas", () => {
    const cache = new TileCache(2 * 10 * 10 * 4); // room for two 10x10 tiles
    const a = canvas(10, 10);
    cache.put("a", a);
    cache.put("b", canvas(10, 10));
    cache.get("a"); // a is now most recent
    cache.put("c", canvas(10, 10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(a);
    expect(cache.bytes).toBe(2 * 400);
  });

  it("freed canvases have zero backing", () => {
    const cache = new TileCache(400);
    const a = canvas(10, 10);
    cache.put("a", a);
    cache.put("b", canvas(10, 10));
    expect(a.width).toBe(0);
  });

  it("dropPrefix removes one document's tiles", () => {
    const cache = new TileCache(1e9);
    cache.put(tileKey("/a.pdf", "1", 1, 2, 0, 0), canvas(1, 1));
    cache.put(tileKey("/b.pdf", "1", 1, 2, 0, 0), canvas(1, 1));
    cache.dropPrefix(tileKeyPrefix("/a.pdf"));
    expect(cache.get(tileKey("/a.pdf", "1", 1, 2, 0, 0))).toBeUndefined();
    expect(cache.get(tileKey("/b.pdf", "1", 1, 2, 0, 0))).toBeDefined();
  });

  it("key includes the document version", () => {
    expect(tileKey("/a.pdf", "1", 1, 2, 0, 0)).not.toBe(tileKey("/a.pdf", "2", 1, 2, 0, 0));
  });
});
