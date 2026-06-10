import { describe, it, expect } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const c = new LruCache<number>(3);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.has("a")).toBe(true);
    expect(c.get("missing")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past the cap", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // evicts "a"
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.size).toBe(2);
  });

  it("get() refreshes recency so the touched key survives eviction", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // "a" is now most-recent
    c.set("c", 3); // evicts "b", not "a"
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });

  it("re-setting an existing key refreshes recency without growing size", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 11); // update + refresh
    c.set("c", 3); // evicts "b"
    expect(c.get("a")).toBe(11);
    expect(c.has("b")).toBe(false);
    expect(c.size).toBe(2);
  });

  it("has() does not refresh recency", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.has("a"); // must NOT mark "a" as recently used
    c.set("c", 3); // evicts "a" (still the oldest)
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
  });

  it("delete removes an entry and keys() lists current entries", () => {
    const c = new LruCache<number>(3);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.delete("a")).toBe(true);
    expect(c.has("a")).toBe(false);
    expect([...c.keys()]).toEqual(["b"]);
  });
});
