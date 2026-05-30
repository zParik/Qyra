import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement matchMedia; components use it via useMediaQuery.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// Shared command registry + call log, created hoisted so the vi.mock factories
// below (also hoisted) can close over them. Tests drive these via src/test/mockTauri.ts.
const handlers = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => unknown>());
const calls = vi.hoisted(() => [] as Array<{ cmd: string; args: Record<string, unknown> }>);

(globalThis as Record<string, unknown>).__tauriHandlers = handlers;
(globalThis as Record<string, unknown>).__tauriCalls = calls;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const handler = handlers.get(cmd);
    if (!handler) {
      return Promise.reject(new Error(`No mock registered for Tauri command: ${cmd}`));
    }
    return Promise.resolve(handler(args));
  },
}));

// Dialog plugin: default to "user cancelled"; tests override via vi.mocked(save).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
  open: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  ask: vi.fn(async () => true),
}));

afterEach(() => {
  cleanup();
  handlers.clear();
  calls.length = 0;
});
