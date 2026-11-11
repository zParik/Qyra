import { useAppStore } from "../store/useAppStore";

const RATIO_KEY = "qyra.splitRatio";

/** Each pane keeps at least a fifth of the width. */
export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(0.8, Math.max(0.2, r));
}

/** Where the divider was left last time (a per-device convenience). */
export function loadRatio(): number {
  try {
    const v = localStorage.getItem(RATIO_KEY);
    return v == null ? 0.5 : clampRatio(parseFloat(v));
  } catch {
    return 0.5;
  }
}

export function saveRatio(r: number) {
  try {
    localStorage.setItem(RATIO_KEY, String(r));
  } catch { /* storage unavailable: the split still works */ }
}

/**
 * Ctrl+\: close the split, or open one with the next other document beside
 * the active one, or the active document twice when it is the only one.
 */
export function toggleSplit() {
  const s = useAppStore.getState();
  if (s.splitTab) return s.closeSplit();
  const docs = s.openTabs.filter((t) => t.type !== "home");
  if (docs.length === 0) return;
  const active = s.openTabs[s.activeTabIndex];
  const at = Math.max(0, s.activeTabIndex);
  const after = s.openTabs.slice(at + 1).concat(s.openTabs.slice(0, at));
  const other = after.find((t) => t.type !== "home" && t.path !== active?.path);
  s.openSplit((other ?? (active?.type !== "home" && active ? active : docs[0]!)).path);
}
