import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bumpDocVersion, getDocVersion, useDocVersion } from "./docVersion";

describe("docVersion", () => {
  it("starts at 0 and increments per path", () => {
    expect(getDocVersion("/v1.pdf")).toBe(0);
    bumpDocVersion("/v1.pdf");
    expect(getDocVersion("/v1.pdf")).toBe(1);
    expect(getDocVersion("/other.pdf")).toBe(0);
  });

  it("re-renders subscribers when their path is bumped", () => {
    const { result } = renderHook(() => useDocVersion("/v2.pdf"));
    expect(result.current).toBe(0);
    act(() => bumpDocVersion("/v2.pdf"));
    expect(result.current).toBe(1);
  });
});
