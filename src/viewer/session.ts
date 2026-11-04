import type { TabEntry } from "../store/useAppStore";

/**
 * The tab session to persist: document tabs only (Library tabs are not saved),
 * with the active index counted within that list. Null when there is nothing
 * to save. A Library tab that is active maps to the first document.
 */
export function sessionToSave(
  openTabs: TabEntry[],
  activeTabIndex: number,
): { tabs: { path: string; name: string }[]; activeIndex: number } | null {
  const docs = openTabs.filter((t) => t.type !== "home");
  if (docs.length === 0) return null;
  const active = openTabs[activeTabIndex];
  const activeIndex = active ? Math.max(0, docs.indexOf(active)) : 0;
  return { tabs: docs.map((t) => ({ path: t.path, name: t.name })), activeIndex };
}
