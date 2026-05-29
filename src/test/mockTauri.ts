// Test-side control surface for the global Tauri mocks installed in setup.ts.
//
// setup.ts replaces `@tauri-apps/api/core` `invoke` with a dispatcher that reads
// from a registry stored on globalThis. Tests register canned handlers per
// command name; unregistered commands reject so missing mocks fail loudly.

type Handler = (args: Record<string, unknown>) => unknown;

function registry(): Map<string, Handler> {
  const reg = (globalThis as { __tauriHandlers?: Map<string, Handler> })
    .__tauriHandlers;
  if (!reg) throw new Error("Tauri mock registry missing — is src/test/setup.ts loaded?");
  return reg;
}

/** Register a canned response (value or function) for one Tauri command. */
export function mockCommand(name: string, handler: Handler | unknown): void {
  registry().set(name, typeof handler === "function" ? (handler as Handler) : () => handler);
}

/** Register several commands at once. */
export function mockCommands(map: Record<string, Handler | unknown>): void {
  for (const [name, handler] of Object.entries(map)) mockCommand(name, handler);
}

/** Inspect calls captured for a command (cleared between tests). */
export function tauriCalls(): Array<{ cmd: string; args: Record<string, unknown> }> {
  return (globalThis as { __tauriCalls?: Array<{ cmd: string; args: Record<string, unknown> }> })
    .__tauriCalls ?? [];
}

/** Last args a command was invoked with, or undefined if never called. */
export function lastCallArgs(name: string): Record<string, unknown> | undefined {
  return [...tauriCalls()].reverse().find((c) => c.cmd === name)?.args;
}
