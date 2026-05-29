import type { Page } from "@playwright/test";

/**
 * Map of Tauri command name -> canned response. Values may be a literal or a
 * function of the invoke args. Overrides are merged over the startup defaults.
 */
export type MockResponses = Record<
  string,
  unknown | ((args: Record<string, unknown>) => unknown)
>;

/**
 * Default responses for the commands the app fires on boot, so a plain Chromium
 * page (no Rust backend) reaches a rendered home screen. Per-test overrides take
 * precedence. Anything unmocked resolves to null and is logged in the console.
 */
const STARTUP_DEFAULTS: MockResponses = {
  // Library / home
  get_starred: [],
  get_archived: [],
  get_entry: null,
  get_setting: null,
  set_setting: null,
  get_disk_space: { total: 512_000_000_000, free: 256_000_000_000, used: 256_000_000_000 },
  // Tabs / session
  get_tab_session: null,
  get_tab_ui_state: null,
  // Open-with / crash / cache
  get_pending_open: null,
  list_crash_logs: [],
  cache_get: null,
  cache_has: false,
  cache_stats: { entries: 0, bytes: 0 },
  // Plugin IPC fired by @tauri-apps/api
  "plugin:event|listen": 0,
  "plugin:event|unlisten": null,
  "plugin:updater|check": null,
};

/**
 * Install the Tauri IPC mock. Must run before the app's scripts, so it is wired
 * via page.addInitScript. The browser-side shim defines window.__TAURI_INTERNALS__
 * with an invoke() that dispatches to a serialized response map.
 */
export async function installTauriMocks(page: Page, overrides: MockResponses = {}): Promise<void> {
  // Functions can't be structured-cloned into addInitScript, so split literal
  // responses (serializable) from function responses (passed as source strings).
  const merged: MockResponses = { ...STARTUP_DEFAULTS, ...overrides };
  const literals: Record<string, unknown> = {};
  const fns: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value === "function") fns[name] = `(${value.toString()})`;
    else literals[name] = value;
  }

  await page.addInitScript(
    ({ literals, fns }) => {
      const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
      for (const [name, src] of Object.entries(fns)) {
        // eslint-disable-next-line no-eval
        handlers[name] = (0, eval)(src as string);
      }
      const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
      (window as unknown as { __tauriCalls: typeof calls }).__tauriCalls = calls;

      const invoke = (cmd: string, args: Record<string, unknown> = {}) => {
        calls.push({ cmd, args });
        if (cmd in handlers) return Promise.resolve(handlers[cmd]!(args));
        if (cmd in literals) return Promise.resolve((literals as Record<string, unknown>)[cmd]);
        console.warn(`[mockInvoke] unmocked Tauri command: ${cmd}`);
        return Promise.resolve(null);
      };

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke,
        transformCallback: (cb: unknown) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      };
    },
    { literals, fns },
  );
}

/** Read the IPC calls captured in the page during the test. */
export async function getInvokeCalls(page: Page): Promise<Array<{ cmd: string; args: Record<string, unknown> }>> {
  return page.evaluate(
    () => (window as unknown as { __tauriCalls?: Array<{ cmd: string; args: Record<string, unknown> }> }).__tauriCalls ?? [],
  );
}
