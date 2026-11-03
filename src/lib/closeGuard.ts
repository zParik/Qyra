import { useAppStore } from "../store/useAppStore";

/** A tab's pending writes (comments) that must reach disk before the window closes. */
export interface CloseFlusher {
  hasPending: () => boolean;
  flush: () => Promise<void>;
}

const flushers = new Set<CloseFlusher>();

/** Register a tab's flusher; returns the unregister function. */
export function registerCloseFlusher(f: CloseFlusher): () => void {
  flushers.add(f);
  return () => flushers.delete(f);
}

/**
 * Decide whether the window may close: ask first when documents have unsaved
 * changes, then wait for every tab's pending writes. A failed write does not
 * keep the window open (it is logged where it fails).
 */
export async function prepareToClose(opts: {
  dirtyCount: number;
  confirm: (message: string) => boolean;
}): Promise<boolean> {
  if (opts.dirtyCount > 0) {
    const what = opts.dirtyCount === 1 ? "A document has" : `${opts.dirtyCount} documents have`;
    if (!opts.confirm(`${what} unsaved changes. Close Qyra anyway?`)) return false;
  }
  await Promise.allSettled([...flushers].filter((f) => f.hasPending()).map((f) => f.flush()));
  return true;
}

/**
 * The window's one close handler. Each tab used to register its own, and a tab
 * with nothing pending let the window be destroyed while another tab was still
 * writing; nothing asked about unsaved documents either.
 */
export async function installCloseGuard(): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  let closing = false;
  return win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    const dirtyCount = Object.values(useAppStore.getState().tabDirty).filter(Boolean).length;
    if (!(await prepareToClose({ dirtyCount, confirm: (m) => window.confirm(m) }))) return;
    closing = true;
    await win.destroy();
  });
}
