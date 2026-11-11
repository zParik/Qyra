import { test, expect } from "./support/fixtures";
import { getInvokeCalls } from "./support/mockInvoke";

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

  test("only page text selects, not the app chrome around it", async ({ page, mockTauri }) => {
    const chars = "Hello".split("").map((c, i) => ({ c, x0: 0.1 + i * 0.02, y0: 0.1, x1: 0.12 + i * 0.02, y1: 0.12 }));
    await mockTauri({
      get_setting: "1",
      get_tab_session: [[{ path: "/x/a.pdf", name: "a.pdf" }], 0],
      doc_open: { pageCount: 1, pages: [{ w: 612, h: 792 }], version: "1" },
      get_page_count: 1,
      get_file_size: 1000,
      get_text_page: [{ chars, x0: 0.1, y0: 0.1, x1: 0.22, y1: 0.12 }],
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
    const selectable = (el: Element) => getComputedStyle(el).userSelect;
    expect(await page.locator("body").evaluate(selectable)).toBe("none");
    expect(await page.locator(".vside").first().evaluate(selectable)).toBe("none");
    expect(await layer.locator("span").first().evaluate(selectable)).toBe("text");
  });
});

test.describe("form filling", () => {
  const formMocks = {
    get_setting: "1",
    get_tab_session: [[{ path: "/x/a.pdf", name: "a.pdf" }], 0],
    doc_open: { pageCount: 1, pages: [{ w: 612, h: 792 }], version: "1" },
    get_page_count: 1,
    get_file_size: 1000,
    get_text_page: [],
    load_comments: "[]",
    get_form_fields: [{ name: "buyer.name", field_type: "Tx", value: "", rect: [0.1, 0.1, 0.5, 0.14], page: 1, flags: 0, options: [], on_state: null }],
    get_page_links: [],
    get_outline: [],
    get_tab_ui_state: [1, 1],
    render_tile: null,
    fill_form: "/tmp/qyra/a-filled.pdf",
    copy_file: null,
  };

  test("fields are live without picking a tool, and Ctrl+S saves them", async ({ page, mockTauri }) => {
    await mockTauri({ ...formMocks, get_form_fields: [{ ...formMocks.get_form_fields[0], value: "Harish" }] });
    page.on("dialog", (d) => d.accept());
    await page.goto("/view");
    const input = page.locator('input[type="text"]').first();
    await expect(input).toHaveValue("Harish");
    await input.fill("Ananya");
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () => (await getInvokeCalls(page)).find((c) => c.cmd === "fill_form")?.args)
      .toMatchObject({ fields: [{ name: "buyer.name", value: "Ananya" }] });
  });

  test("typed text stays dark on the white page in dark theme", async ({ page, mockTauri }) => {
    await mockTauri(formMocks);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/view");
    const input = page.locator('input[type="text"]').first();
    await input.fill("Ananya");
    await expect(input).toHaveCSS("color", "rgb(17, 17, 17)");
  });

  test("Ctrl+S with the caret in a field saves the typed value", async ({ page, mockTauri }) => {
    await mockTauri(formMocks);
    // The mock answers every setting with "1", so "confirm before overwriting" is on.
    page.on("dialog", (d) => d.accept());
    await page.goto("/view");
    const input = page.locator('input[type="text"]').first();
    await input.click();
    await page.keyboard.type("Ananya");
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () => (await getInvokeCalls(page)).find((c) => c.cmd === "fill_form")?.args)
      .toMatchObject({ path: "/x/a.pdf", fields: [{ name: "buyer.name", value: "Ananya" }] });
    await expect
      .poll(async () => (await getInvokeCalls(page)).some((c) => c.cmd === "copy_file"))
      .toBe(true);
  });
});


test.describe("split view", () => {
  const docs = (tabs: string[]) => ({
    get_setting: "1",
    get_tab_session: [tabs.map((t) => ({ path: `/x/${t}`, name: t })), 0],
    doc_open: { pageCount: 1, pages: [{ w: 612, h: 792 }], version: "1" },
    get_page_count: 1,
    get_file_size: 1000,
    get_text_page: [],
    load_comments: "[]",
    get_form_fields: [],
    get_page_links: [],
    get_outline: [],
    get_tab_ui_state: [1, 1],
    render_tile: null,
  });
  const visiblePanes = (page: import("@playwright/test").Page) =>
    page.locator(".split-pane").filter({ has: page.locator(".toolbar") }).filter({ visible: true });

  test("Ctrl+\\ shows the next document beside the active one", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await expect(page.locator(".toolbar-name", { hasText: "a.pdf" }).first()).toBeVisible();
    await page.keyboard.press("Control+Backslash");
    await expect(visiblePanes(page)).toHaveCount(2);
    await expect(page.getByRole("separator", { name: /resize split view/i })).toBeVisible();
    await expect(page.locator('.tab[data-split="true"]')).toContainText("b.pdf");
    // Both panes edit: neither is view only.
    await expect(page.getByText("View only")).toHaveCount(0);
  });

  test("clicking a pane gives it the keyboard", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await expect(page.locator(".toolbar-name", { hasText: "a.pdf" }).first()).toBeVisible();
    await page.keyboard.press("Control+Backslash");
    const panes = visiblePanes(page);
    await expect(panes).toHaveCount(2);
    const left = page.locator(".split-pane", { has: page.locator(".toolbar-name", { hasText: "a.pdf" }) });
    const right = page.locator(".split-pane", { has: page.locator(".toolbar-name", { hasText: "b.pdf" }) });
    await expect(right).toHaveAttribute("data-focused", "");
    await left.locator(".toolbar-name").click();
    await expect(left).toHaveAttribute("data-focused", "");
    await expect(right).not.toHaveAttribute("data-focused", "");
  });

  test("the same document twice opens view only on the right", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf"]));
    await page.goto("/view");
    await page.getByRole("button", { name: "Split view" }).click();
    await expect(visiblePanes(page)).toHaveCount(2);
    const right = page.locator(".split-pane").filter({ hasText: "View only" });
    await expect(right).toBeVisible();
    await expect(right.getByRole("group", { name: "Markup" })).toHaveCount(0);
    await expect(right.getByTitle("Show or hide the tools")).toHaveCount(0);
    await right.getByRole("button", { name: "Close split view" }).click();
    await expect(visiblePanes(page)).toHaveCount(1);
    await expect(page.getByText("View only")).toHaveCount(0);
  });

  test("dragging a tab onto the right half of the page splits it", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await expect(page.locator(".toolbar-name", { hasText: "a.pdf" }).first()).toBeVisible();
    const box = (await page.locator(".tab", { hasText: "b.pdf" }).boundingBox())!;
    const vp = page.viewportSize()!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 4 });
    await page.mouse.move(vp.width * 0.8, vp.height * 0.5, { steps: 8 });
    await expect(page.locator(".split-drop-zone[data-on]")).toContainText("Open on the right");
    await page.mouse.up();
    await expect(page.locator('.tab[data-split="true"]')).toContainText("b.pdf");
    await expect(visiblePanes(page)).toHaveCount(2);
    await expect(page.locator(".split-drop")).toHaveCount(0);
  });

  test("dragging a tab onto the left half puts it in front", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await expect(page.locator(".toolbar-name", { hasText: "a.pdf" }).first()).toBeVisible();
    const box = (await page.locator(".tab", { hasText: "b.pdf" }).boundingBox())!;
    const vp = page.viewportSize()!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 4 });
    await page.mouse.move(vp.width * 0.2, vp.height * 0.5, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.tab[data-active="true"]')).toContainText("b.pdf");
    await expect(page.locator('.tab[data-split="true"]')).toContainText("a.pdf");
  });

  test("dragging a tab along the bar still reorders", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await expect(page.locator(".toolbar-name", { hasText: "a.pdf" }).first()).toBeVisible();
    const a = (await page.locator(".tab", { hasText: "a.pdf" }).boundingBox())!;
    const b = (await page.locator(".tab", { hasText: "b.pdf" }).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 10, a.y + a.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".tab").first()).toContainText("b.pdf");
    await expect(page.locator('.tab[data-split="true"]')).toHaveCount(0);
  });

  test("the split button lists open documents", async ({ page, mockTauri }) => {
    await mockTauri(docs(["a.pdf", "b.pdf"]));
    await page.goto("/view");
    await page.locator(".split-pane").filter({ visible: true }).getByRole("button", { name: "Split view" }).click();
    const menu = page.getByRole("menu", { name: /show on the right/i });
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await menu.getByRole("menuitem", { name: /b\.pdf/ }).click();
    await expect(page.locator('.tab[data-split="true"]')).toContainText("b.pdf");
  });
});
