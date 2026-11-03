import { test, expect } from "./support/fixtures";

// Real user flows against the built UI with the Tauri backend mocked.
test.describe("home", () => {
  test("renders the drop hero and tool sections", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /drop a pdf here/i }),
    ).toBeVisible();
    // Merge is reachable twice: from the rail and from the tool row.
    await expect(page.locator(".tool-row", { hasText: /merge pdfs/i })).toBeVisible();
  });

  test("shows the empty recents state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/no sheets on the shelf yet/i)).toBeVisible();
  });
});

test.describe("navigation", () => {
  test("opening the Merge tool routes to /merge", async ({ page }) => {
    await page.goto("/");
    await page.locator(".tool-row", { hasText: /merge pdfs/i }).click();
    await expect(page).toHaveURL(/\/merge$/);
  });

  test("deep-linking to /settings renders the settings screen", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("#root")).not.toBeEmpty();
    // Back-navigation returns to home.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /drop a pdf here/i })).toBeVisible();
  });
});

test.describe("theme toggle", () => {
  test("switches the theme when a choice is pressed", async ({ page }) => {
    await page.goto("/");
    const dark = page.getByRole("button", { name: /^Theme: Dark/ });
    await expect(dark).toBeVisible();
    await dark.click();
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
  });
});

test.describe("viewer", () => {
  test("reopening a document scrolls back to its saved page", async ({ page, mockTauri }) => {
    const pages = Array.from({ length: 12 }, () => ({ w: 612, h: 792 }));
    await mockTauri({
      get_setting: "1",
      get_tab_session: [[{ path: "/x/a.pdf", name: "a.pdf" }], 0],
      doc_open: { pageCount: 12, pages, version: "1" },
      get_page_count: 12,
      get_file_size: 1000,
      get_text_page: [],
      load_comments: "[]",
      get_form_fields: [],
      get_page_links: [],
      get_outline: [],
      get_tab_ui_state: [7, 1],
      render_tile: null,
    });
    await page.goto("/view");
    // Page 7 must be on screen, not just marked current while the view stays at page 1.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector('[data-page-index="7"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top < innerHeight && r.bottom > 0;
        }),
      )
      .toBe(true);
  });

  test("selecting page text raises the markup popup", async ({ page, mockTauri }) => {
    const chars = "Hello Qyra".split("").map((c, i) => ({ c, x0: 0.1 + i * 0.02, y0: 0.1, x1: 0.12 + i * 0.02, y1: 0.12 }));
    await mockTauri({
      get_setting: "1",
      get_tab_session: [[{ path: "/x/a.pdf", name: "a.pdf" }], 0],
      doc_open: { pageCount: 1, pages: [{ w: 612, h: 792 }], version: "1" },
      get_page_count: 1,
      get_file_size: 1000,
      get_text_page: [{ chars, x0: 0.1, y0: 0.1, x1: 0.32, y1: 0.12 }],
      load_comments: "[]",
      get_form_fields: [],
      get_page_links: [],
      get_outline: [],
      get_tab_ui_state: [1, 1],
      render_tile: null,
    });
    await page.goto("/view");
    const layer = page.locator(".textLayer").first();
    await expect(layer).toContainText("Hello");
    await layer.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { button: 0 }));
    });
    await expect(page.getByTitle("Highlight")).toBeVisible();
  });
});

