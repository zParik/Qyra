// Platform helpers for OS-aware UI (keyboard-shortcut modifier labels, etc).

export function isMacPlatform(platform: string): boolean {
  return /mac/i.test(platform);
}

export function modKeyFor(platform: string): string {
  return isMacPlatform(platform) ? "⌘" : "Ctrl";
}

/** A display label for a single-letter shortcut, e.g. "⌘M" on mac, "Ctrl+M" elsewhere. */
export function shortcutLabelFor(platform: string, letter: string): string {
  return isMacPlatform(platform) ? `⌘${letter}` : `Ctrl+${letter}`;
}

const currentPlatform = (): string =>
  typeof navigator !== "undefined" ? navigator.platform : "";

export const isMac = (): boolean => isMacPlatform(currentPlatform());
export const modKey = (): string => modKeyFor(currentPlatform());
export const shortcutLabel = (letter: string): string =>
  shortcutLabelFor(currentPlatform(), letter);
