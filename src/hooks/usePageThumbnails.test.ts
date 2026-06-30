import { describe, it, expect } from "vitest";
import { renderPage, seedThumbnailsForEdit } from "./usePageThumbnails";
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

// Seeding copies unchanged pages to the new path so an in-place edit re-renders
// only the changed page. Regression guard: the cache's keys() is a live Map
// iterator and get()/set() reorder it, so iterating it while reading/writing
// looped forever (the page "crashed"/hung). This test would time out under that bug.
describe("seedThumbnailsForEdit", () => {
  it("seeds unchanged pages under the new path and terminates", async () => {
    mockCommands({
      cache_get: () => null,
      thumb_get: () => null,
      render_page: () => "QQ==",
      cache_put: () => undefined,
      thumb_put: () => undefined,
    });

    // Populate two pages of the old document into the in-memory cache.
    await renderPage("/seed-old.pdf", 1, 2, () => false);
    await renderPage("/seed-old.pdf", 2, 2, () => false);

    // Page 2 changed, page 1 unchanged. Must return (no infinite loop).
    seedThumbnailsForEdit("/seed-old.pdf", "/seed-new.pdf", new Set([2]));

    // Unchanged page 1 is now a layer-1 cache hit under the new path — returns
    // even with the cancel predicate true (the hit precedes the cancel check).
    await expect(renderPage("/seed-new.pdf", 1, 2, () => true))
      .resolves.toBe("data:image/jpeg;base64,QQ==");
    // Changed page 2 was NOT seeded → no hit → the cancel predicate trips.
    await expect(renderPage("/seed-new.pdf", 2, 2, () => true))
      .rejects.toThrow("Cancelled");
  });
});
