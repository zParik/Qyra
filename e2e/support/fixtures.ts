import { test as base, expect } from "@playwright/test";
import { installTauriMocks, getInvokeCalls, type MockResponses } from "./mockInvoke";

/**
 * Playwright base test with the Tauri IPC mock pre-installed (startup defaults)
 * via an automatic fixture, so it applies whether or not a test destructures it.
 * Use `mockTauri(overrides)` to add/override command responses BEFORE navigating,
 * and `invokeCalls()` to assert what the UI dispatched.
 */
export const test = base.extend<{
  _autoTauriMock: void;
  mockTauri: (overrides: MockResponses) => Promise<void>;
  invokeCalls: () => Promise<Array<{ cmd: string; args: Record<string, unknown> }>>;
}>({
  _autoTauriMock: [
    async ({ page }, use) => {
      await installTauriMocks(page);
      await use();
    },
    { auto: true },
  ],
  mockTauri: async ({ page }, use) => {
    await use((overrides: MockResponses) => installTauriMocks(page, overrides));
  },
  invokeCalls: async ({ page }, use) => {
    await use(() => getInvokeCalls(page));
  },
});

export { expect };
