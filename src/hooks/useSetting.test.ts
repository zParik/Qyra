import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const stored = vi.fn();
vi.mock("../lib/settings", () => ({
  // The stored value equals the default, as on a fresh install.
  loadSetting: async (spec: { default: unknown }) => spec.default,
  storeSetting: (...a: unknown[]) => stored(...a),
}));

import { useSetting } from "./useSetting";

const spec = { key: "auto_save", default: false } as never;

beforeEach(() => stored.mockReset());

describe("useSetting", () => {
  it("saves the first change when the stored value equals the default", async () => {
    const { result } = renderHook(() => useSetting<boolean>(spec));
    await waitFor(() => expect(result.current[2]).toBe(true));
    act(() => result.current[1](true));
    expect(stored).toHaveBeenCalledWith(spec, true);
  });

  it("does not write back the value it loaded", async () => {
    const { result } = renderHook(() => useSetting<boolean>(spec));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(stored).not.toHaveBeenCalled();
  });
});
