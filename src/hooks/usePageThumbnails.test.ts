import { describe, it, expect } from "vitest";
import { renderPage } from "./usePageThumbnails";
import { mockCommands, tauriCalls } from "../test/mockTauri";

// renderPage is the single funnel every page render goes through. The viewer
// passes a cancel predicate that returns true once a page scrolls outside the
// render window; these tests lock in that a cancelled request never reaches the
// Rust renderer, which is what stops a fast-scroll backlog from rasterizing
// pages no one is looking at.
describe("renderPage cancellation", () => {
  it("bails before any Rust work when already cancelled", async () => {
    let rendered = false;
    mockCommands({
      cache_get: () => null,
      thumb_get: () => null,
      render_page: () => { rendered = true; return ""; },
    });

    await expect(
      renderPage("/cancelled.pdf", 7, 2, () => true),
    ).rejects.toThrow("Cancelled");

    expect(rendered).toBe(false);
    expect(tauriCalls().some((c) => c.cmd === "render_page")).toBe(false);
  });

  it("renders via Rust when not cancelled", async () => {
    mockCommands({
      cache_get: () => null,
      thumb_get: () => null,
      render_page: () => "QQ==",
      cache_put: () => undefined,
      thumb_put: () => undefined,
    });

    const url = await renderPage("/fresh.pdf", 1, 2, () => false);

    expect(url).toBe("data:image/jpeg;base64,QQ==");
    expect(tauriCalls().some((c) => c.cmd === "render_page")).toBe(true);
  });
});
