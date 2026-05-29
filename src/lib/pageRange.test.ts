import { describe, it, expect } from "vitest";
import { parsePages, formatPages } from "./pageRange";

describe("parsePages", () => {
  it("parses singles, ranges, and whitespace", () => {
    expect(parsePages("1, 3-5, 7", 10)).toEqual([1, 3, 4, 5, 7]);
  });

  it("dedupes and sorts overlapping parts", () => {
    expect(parsePages("5, 1-3, 2", 10)).toEqual([1, 2, 3, 5]);
  });

  it("drops out-of-range and malformed parts", () => {
    expect(parsePages("0, 2, 11, 4-2, abc, 5-7", 8)).toEqual([2, 5, 6, 7]);
  });

  it("returns empty for empty input", () => {
    expect(parsePages("", 10)).toEqual([]);
  });
});

describe("formatPages", () => {
  it("collapses consecutive runs into ranges", () => {
    expect(formatPages([1, 3, 4, 5, 7])).toBe("1, 3-5, 7");
  });

  it("round-trips with parsePages", () => {
    const input = [2, 5, 6, 7];
    expect(parsePages(formatPages(input), 10)).toEqual(input);
  });

  it("returns empty string for no pages", () => {
    expect(formatPages([])).toBe("");
  });
});
