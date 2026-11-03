import { useEffect, useCallback, useState } from "react";
import { useLocation, useNavigate, useOutlet } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, TabEntry } from "../store/useAppStore";
import { TabBar } from "./TabBar";
import Viewer from "./Viewer";
import Home from "../tools/Home";
import { ErrorBoundary } from "react-error-boundary";
import { ViewerErrorFallback } from "../components/ErrorFallback";
import { ShortcutsModal } from "../components/ShortcutsModal";
import { loadSetting, Settings } from "../lib/settings";

export default function ViewerShell() {
  const navigate = useNavigate();
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const activateTab = useAppStore((s) => s.activateTab);
  const replaceTab = useAppStore((s) => s.replaceTab);
  const reopenClosedTab = useAppStore((s) => s.reopenClosedTab);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);
  const tabDirty = useAppStore((s) => s.tabDirty);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // A tool page or Settings renders through the outlet, over the tabs, which stay mounted and hidden.
  // (The outlet element exists even for the library and viewer routes, so the path decides.)
  const outlet = useOutlet();
  const { pathname } = useLocation();
  const onToolRoute = pathname !== "/" && pathname !== "/view";
  const activeTab = openTabs[activeTabIndex];
  const homeVisible = activeTab?.type === "home" && !onToolRoute;

  // Load persisted session on first mount (only if no tabs already open),
  // gated on the reopen-tabs-on-launch preference.
  useEffect(() => {
    if (openTabs.length > 0) return;
    let alive = true;
    loadSetting(Settings.reopenTabsOnLaunch).then((reopen) => {
      if (!alive) return;
      if (!reopen) {
        openTab({ type: "home", path: "__home__0", name: "Library" });
        return;
      }
      invoke<[TabEntry[], number]>("get_tab_session").then(([tabs, active]) => {
        if (!alive) return;
        if (tabs.length === 0) {
          openTab({ type: "home", path: "__home__0", name: "Library" });
          return;
        }
        tabs.forEach((t) =>
          openTab(
            t.path.startsWith("__home__")
              ? { type: "home", path: t.path, name: t.name }
              : { type: "pdf", path: t.path, name: t.name }
          )
        );
        activateTab(active);
      }).catch(() => {
        openTab({ type: "home", path: "__home__0", name: "Library" });
      });
    });
    return () => { alive = false; };
  }, []);

  // Persist session whenever tabs or active index change (skip home-only sessions)
  useEffect(() => {
    const savable = openTabs.filter((t) => t.type !== "home");
    if (savable.length === 0) return;
    invoke("save_tab_session", {
      tabs: savable.map((t) => ({ path: t.path, name: t.name })),
      activeIndex: activeTabIndex,
    }).catch(console.error);
  }, [openTabs, activeTabIndex]);

  // Persist session on page unload
  useEffect(() => {
    const handler = () => {
      const savable = openTabs.filter((t) => t.type !== "home");
      if (savable.length === 0) return;
      invoke("save_tab_session", {
        tabs: savable.map((t) => ({ path: t.path, name: t.name })),
        activeIndex: activeTabIndex,
      });
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [openTabs, activeTabIndex]);

  // Open a new home tab (Ctrl+T, + button)
  const handleNewTab = useCallback(() => {
    openTab({ type: "home", path: `__home__${Date.now()}`, name: "Library" });
    if (onToolRoute) navigate("/");
  }, [openTab, onToolRoute, navigate]);

  // Clicking a tab while a tool page is up returns to the sheets.
  const handleActivateTab = useCallback(() => {
    if (onToolRoute) navigate("/view");
  }, [onToolRoute, navigate]);

  const handleCloseTab = useCallback((index: number) => {
    const tab = openTabs[index];
    if (tab && tab.type !== "home" && tabDirty[tab.path]) {
      if (!confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
    }
    closeTab(index);
    if (openTabs.length <= 1) {
      invoke("clear_tab_session").catch(console.error);
      // The shell never goes blank: closing the last sheet leaves the library open.
      openTab({ type: "home", path: `__home__${Date.now()}`, name: "Library" });
      navigate("/");
    }
  }, [openTabs, tabDirty, closeTab, openTab, navigate]);

  // Called by the singleton Home when user opens a PDF from a home tab
  const handleHomePdfOpen = useCallback((path: string, name: string) => {
    setTabOriginal(path, path);
    setTabDirty(path, false);
    setTabUndo(path, null);
    if (activeTabIndex >= 0 && openTabs[activeTabIndex]?.type === "home") {
      replaceTab(activeTabIndex, { type: "pdf", path, name });
    } else {
      openTab({ type: "pdf", path, name });
    }
  }, [activeTabIndex, openTabs, replaceTab, openTab, setTabOriginal, setTabDirty, setTabUndo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // "?" cheatsheet — Shift+/ on US layouts; ignore when typing into inputs.
      const tgt = e.target as HTMLElement | null;
      const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !inField && e.key === "?") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        reopenClosedTab();
      } else if (e.ctrlKey && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        handleNewTab();
      } else if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabIndex >= 0) handleCloseTab(activeTabIndex);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (openTabs.length > 1) {
          const next = e.shiftKey
            ? (activeTabIndex - 1 + openTabs.length) % openTabs.length
            : (activeTabIndex + 1) % openTabs.length;
          activateTab(next);
        }
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        // Ctrl+1..8 jump to tab N (1-indexed). Ctrl+9 jumps to the last tab.
        e.preventDefault();
        const n = parseInt(e.key, 10);
        const target = n === 9 ? openTabs.length - 1 : Math.min(n - 1, openTabs.length - 1);
        if (target >= 0 && target !== activeTabIndex) activateTab(target);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabIndex, openTabs.length, handleNewTab, handleCloseTab, activateTab, reopenClosedTab]);

  if (openTabs.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
      <TabBar
        onOpenFile={handleNewTab}
        onCloseTab={handleCloseTab}
        onOpenExternalFile={(path, name) => { openTab({ type: "pdf", path, name }); if (onToolRoute) navigate("/view"); }}
        onActivateTab={handleActivateTab}
      />
      <ShortcutsModal open={showShortcuts} onOpenChange={setShowShortcuts} />
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        {/* Singleton Home — visible when active tab is a home tab */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            visibility: homeVisible ? "visible" : "hidden",
            pointerEvents: homeVisible ? "auto" : "none",
          }}
        >
          <Home onOpenPdf={handleHomePdfOpen} />
        </div>
        {/* PDF tabs stack */}
        {openTabs.map((tab, i) =>
          tab.type === "home" ? null : (
            <div
              key={tab.path}
              style={{
                position: "absolute",
                inset: 0,
                visibility: i === activeTabIndex && !onToolRoute ? "visible" : "hidden",
                pointerEvents: i === activeTabIndex && !onToolRoute ? "auto" : "none",
              }}
            >
              <ErrorBoundary FallbackComponent={ViewerErrorFallback} key={tab.path}>
                <Viewer tabPath={tab.path} isActive={i === activeTabIndex && !onToolRoute} />
              </ErrorBoundary>
            </div>
          )
        )}
        {/* Tool pages and Settings, on top of the sheets */}
        {onToolRoute && (
          <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg0)" }}>
            {outlet}
          </div>
        )}
      </div>
    </div>
  );
}
