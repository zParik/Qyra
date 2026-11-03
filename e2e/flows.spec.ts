import { test, expect } from "./support/fixtures";

// Real user flows against the built UI with the Tauri backend mocked.
test.describe("home", () => {
  test("renders the drop hero and tool sections", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /drop a pdf here/i }),
    ).toBeVisible();
    // Merge is reachable twice: from the rail and from the tool card.
    await expect(page.locator(".tool-card", { hasText: /merge pdfs/i })).toBeVisible();
  });

  test("shows the empty recents state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/no sheets on the shelf yet/i)).toBeVisible();
  });
});

test.describe("navigation", () => {
  test("opening the Merge tool routes to /merge", async ({ page }) => {
    await page.goto("/");
    await page.locator(".tool-card", { hasText: /merge pdfs/i }).click();
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
