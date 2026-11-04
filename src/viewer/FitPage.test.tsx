import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../render/renderClient", async (orig) => ({
  ...(await orig<typeof import("../render/renderClient")>()),
  docOpen: vi.fn().mockResolvedValue({ pageCount: 1, pages: [{ w: 612, h: 792 }], version: "3" }),
  renderTile: vi.fn().mockResolvedValue(null),
}));

import { FitPage } from "./FitPage";

beforeAll(() => {
  // jsdom has no layout: report a 408 x 2000 container (width-limited fit).
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([{ contentRect: { width: 408, height: 2000 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("FitPage", () => {
  it("fits the page inside its container and renders it with PageView", async () => {
    const { container } = render(<FitPage path="/a.pdf" page={1} />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    // 612pt * 96/72 = 816 css px at zoom 1 → zoom 0.5 fits 408 px.
    const box = container.querySelector("img")!.parentElement as HTMLElement;
    expect(box.style.width).toBe("408px");
    expect(container.querySelector("img")!.getAttribute("src")).toContain("thumb/1?path=%2Fa.pdf&w=512&v=3");
  });
});
