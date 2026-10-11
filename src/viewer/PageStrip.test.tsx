import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// jsdom has no layout, so the real virtualizer renders nothing; expose every row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 120, size: 120, key: i })),
    getTotalSize: () => count * 120,
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

import { PageStrip } from "./PageStrip";

describe("PageStrip", () => {
  it("loads each page's thumbnail from the qyra:// scheme", () => {
    const { container } = render(
      <PageStrip path="/a.pdf" version="7" pageCount={2} currentPage={1} onPageSelect={() => {}} />,
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toContain("thumb/1?path=%2Fa.pdf&w=256&v=7");
    expect(imgs[1]!.getAttribute("src")).toContain("thumb/2?path=%2Fa.pdf&w=256&v=7");
  });
});
