import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewerUI } from "./useViewerUI";

// A window width we can change, with matchMedia("(min-width: Npx)") following it.
let width = 1400;
const lists = new Set<{ min: number; cb: (e: { matches: boolean }) => void }>();
function resize(w: number) {
  width = w;
  act(() => { for (const l of lists) l.cb({ matches: width >= l.min }); });
}

beforeEach(() => {
  width = 1400;
  lists.clear();
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    let entry: { min: number; cb: (e: { matches: boolean }) => void } | null = null;
    return {
      get matches() { return width >= min; },
      media: query,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { entry = { min, cb }; lists.add(entry); },
      removeEventListener: () => { if (entry) lists.delete(entry); },
    } as unknown as MediaQueryList;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useViewerUI sidebars", () => {
  it("shows both sidebars in a wide window", () => {
    const { result } = renderHook(() => useViewerUI());
    expect(result.current.showStrip).toBe(true);
    expect(result.current.showTools).toBe(true);
  });

  it("starts with the tools hidden in a narrow window", () => {
    width = 1000;
    const { result } = renderHook(() => useViewerUI());
    expect(result.current.showTools).toBe(false);
    expect(result.current.showStrip).toBe(true);
  });

  it("collapses and restores the sidebars as the window crosses the breakpoints", () => {
    const { result } = renderHook(() => useViewerUI());
    resize(850);
    expect(result.current.showTools).toBe(false);
    expect(result.current.showStrip).toBe(false);
    resize(1300);
    expect(result.current.showTools).toBe(true);
    expect(result.current.showStrip).toBe(true);
  });

  it("keeps a manual toggle until the next breakpoint crossing", () => {
    width = 1000;
    const { result } = renderHook(() => useViewerUI());
    act(() => result.current.setShowTools(true));
    expect(result.current.showTools).toBe(true);
  });
});
