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
});
