import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderTile = vi.fn();
vi.mock("../render/renderClient", async (orig) => ({
  ...(await orig<typeof import("../render/renderClient")>()),
  renderTile: (...a: unknown[]) => renderTile(...a),
}));

import { PageView } from "./PageView";

const base = { path: "/a.pdf", version: "1", page: 1, sizePt: { w: 612, h: 792 }, zoom: 1, dpr: 1 };

beforeEach(() => {
  renderTile.mockReset();
  renderTile.mockResolvedValue(null);
});

describe("PageView", () => {
  it("always shows the preview thumbnail sized to the page box", () => {
    const { container } = render(<PageView {...base} visibleCss={null} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("thumb/1?path=%2Fa.pdf&w=512");
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.width).toBe("816px");
    expect(box.style.height).toBe("1056px");
  });

  it("requests no tiles when not visible", async () => {
    render(<PageView {...base} visibleCss={null} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(renderTile).not.toHaveBeenCalled();
  });

  it("requests the visible tiles at the exact scale", async () => {
    render(<PageView {...base} visibleCss={{ x0: 0, y0: 0, x1: 100, y1: 100 }} />);
    await waitFor(() => expect(renderTile).toHaveBeenCalled());
    const first = renderTile.mock.calls[0][0];
    expect(first).toMatchObject({ path: "/a.pdf", page: 1, tx: 0, ty: 0, priority: "visible" });
    expect(first.scale).toBeCloseTo(96 / 72);
  });

  it("renders overlay children", () => {
    render(<PageView {...base} visibleCss={null}><span>overlay</span></PageView>);
    expect(screen.getByText("overlay")).toBeTruthy();
  });

  it("sizes the box to whole device pixels so tiles map 1:1", () => {
    // 612pt * 4/3 * 1.1 = 897.6 css; * 1.5 dpr = 1346.4 → 1347 device px → 898 css.
    const { container } = render(<PageView {...base} zoom={1.1} dpr={1.5} visibleCss={null} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.width).toBe("898px");
  });

  it("bounds prefetch at 1600% on a HiDPI screen", async () => {
    render(<PageView {...base} zoom={16} dpr={2} visibleCss={{ x0: 0, y0: 0, x1: 1920, y1: 1080 }} />);
    await waitFor(() => expect(renderTile).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    // Visible area alone is ~8x5 tiles; prefetch must not balloon to hundreds.
    expect(renderTile.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it("keeps in-flight tiles that are still wanted when the window moves", async () => {
    renderTile.mockImplementation(() => new Promise(() => {})); // never resolves
    const { rerender } = render(<PageView {...base} visibleCss={{ x0: 0, y0: 0, x1: 100, y1: 100 }} />);
    await waitFor(() => expect(renderTile).toHaveBeenCalled());
    const firstSignal = renderTile.mock.calls[0][1] as AbortSignal;
    const callsBefore = renderTile.mock.calls.length;
    // Window moves down so tile row 1 becomes wanted while row 0 still is.
    rerender(<PageView {...base} visibleCss={{ x0: 0, y0: 400, x1: 100, y1: 500 }} />);
    await waitFor(() => expect(renderTile.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(firstSignal.aborted).toBe(false);
    expect(renderTile.mock.calls.filter((c) => c[0].tx === 0 && c[0].ty === 0)).toHaveLength(1);
  });
});
