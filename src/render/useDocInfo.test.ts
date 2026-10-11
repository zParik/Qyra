import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const docOpen = vi.fn();
vi.mock("./renderClient", async (orig) => ({
  ...(await orig<typeof import("./renderClient")>()),
  docOpen: (p: string) => docOpen(p),
}));

import { useDocInfo } from "./useDocInfo";
import { bumpDocVersion } from "./docVersion";

const info = (v: string) => ({ pageCount: 1, pages: [{ w: 612, h: 792 }], version: v });

beforeEach(() => docOpen.mockReset());

describe("useDocInfo", () => {
  it("loads the document's info", async () => {
    docOpen.mockResolvedValue(info("1"));
    const { result } = renderHook(() => useDocInfo("/u1.pdf"));
    await waitFor(() => expect(result.current?.version).toBe("1"));
  });

  it("re-fetches after the file is rewritten (version bump)", async () => {
    docOpen.mockResolvedValueOnce(info("1")).mockResolvedValueOnce(info("2"));
    const { result } = renderHook(() => useDocInfo("/u2.pdf"));
    await waitFor(() => expect(result.current?.version).toBe("1"));
    act(() => bumpDocVersion("/u2.pdf"));
    await waitFor(() => expect(result.current?.version).toBe("2"));
  });

  it("never returns the previous document's info for a new path", async () => {
    docOpen.mockResolvedValueOnce(info("a")).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ p }) => useDocInfo(p), { initialProps: { p: "/a.pdf" } });
    await waitFor(() => expect(result.current?.version).toBe("a"));
    rerender({ p: "/b.pdf" });
    expect(result.current).toBeNull();
  });
});
