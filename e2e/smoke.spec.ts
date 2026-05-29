import { test, expect } from "./support/fixtures";

// P0 harness smoke: prove the app boots in plain Chromium with the IPC mock,
// renders the home screen, and that startup commands were dispatched through it.
test.describe("harness smoke", () => {
  test("app boots and renders home", async ({ page }) => {
    await page.goto("/");

    const root = page.locator("#root");
    await expect(root).not.toBeEmpty();
    // Something interactive must be present (tool cards / nav buttons).
    await expect(page.locator("button").first()).toBeVisible();
  });

  test("startup fires Tauri commands through the mock", async ({ page, invokeCalls }) => {
    await page.goto("/");
    await expect(page.locator("#root")).not.toBeEmpty();

    const calls = await invokeCalls();
    expect(calls.length).toBeGreaterThan(0);
  });
});
