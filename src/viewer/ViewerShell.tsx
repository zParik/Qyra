import { useEffect, useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
import { sessionToSave } from "./session";
import { clampRatio, loadRatio, saveRatio, toggleSplit } from "./split";

export default function ViewerShell() {
  const navigate = useNavigate();
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const activateTab = useAppStore((s) => s.activateTab);
  const openDocument = useAppStore((s) => s.openDocument);
  const reopenClosedTab = useAppStore((s) => s.reopenClosedTab);
  const tabDirty = useAppStore((s) => s.tabDirty);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const splitTab = useAppStore((s) => s.splitTab);
  const focusedPane = useAppStore((s) => s.focusedPane);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const [ratio, setRatio] = useState(loadRatio);

  // A tool page or Settings renders through the outlet, over the tabs, which stay mounted and hidden.
  // (The outlet element exists even for the library and viewer routes, so the path decides.)
  const outlet = useOutlet();
  const { pathname } = useLocation();
  const onToolRoute = pathname !== "/" && pathname !== "/view";
  const activeTab = openTabs[activeTabIndex];
  const homeVisible = activeTab?.type === "home" && !onToolRoute;
  // Split view: the split tab shows on the right. When it is the active tab
  // itself, the right pane is a second, read-only view of that document.
  const splitOn = !!splitTab && !onToolRoute && openTabs.some((t) => t.path === splitTab && t.type !== "home");
  const mirror = splitOn && activeTab?.path === splitTab;
  const at = `${(ratio * 100).toFixed(2)}%`;
  const mainStyle: CSSProperties = splitOn ? { left: 0, top: 0, bottom: 0, width: `calc(${at} - 3px)` } : { inset: 0 };
  const splitStyle: CSSProperties = { left: `calc(${at} + 3px)`, right: 0, top: 0, bottom: 0 };
  const paneRef = useRef<HTMLDivElement>(null);

  // Load persisted session on first mount (only if no tabs already open),
  // gated on the reopen-tabs-on-launch preference. Then open the file Qyra
  // was launched with ("Open with"; Rust holds it until asked). Opening it
  // first let the restore add its tabs after and switch away from it.
  useEffect(() => {
    let alive = true;
    const home = () => openTab({ type: "home", path: "__home__0", name: "Library" });
    async function restore() {
      if (useAppStore.getState().openTabs.length > 0) return;
      if (!(await loadSetting(Settings.reopenTabsOnLaunch))) {
        if (alive) home();
        return;
      }
      const session = await invoke<[TabEntry[], number]>("get_tab_session").catch(() => null);
      if (!alive) return;
      const [tabs, active] = Array.isArray(session) ? session : [[], 0];
      if (!Array.isArray(tabs) || tabs.length === 0) return home();
      tabs.forEach((t) =>
        openTab(
          t.path.startsWith("__home__")
            ? { type: "home", path: t.path, name: t.name }
            : { type: "pdf", path: t.path, name: t.name }
        )
      );
      activateTab(active);
    }
    restore().catch(() => {
      if (alive && useAppStore.getState().openTabs.length === 0) home();
    }).finally(async () => {
      if (!alive) return;
      const path = await invoke<string | null>("get_pending_open").catch(() => null);
      if (!path || !alive) return;
      openDocument(path, path.split(/[\\/]/).pop() ?? path);
      navigate("/view");
    });
    return () => { alive = false; };
  }, []);

  // Persist session whenever tabs or active index change (skip home-only sessions)
  useEffect(() => {
    const session = sessionToSave(openTabs, activeTabIndex);
    if (session) invoke("save_tab_session", session).catch(console.error);
  }, [openTabs, activeTabIndex]);

  // Persist session on page unload
  useEffect(() => {
    const handler = () => {
      const session = sessionToSave(openTabs, activeTabIndex);
      if (session) invoke("save_tab_session", session);
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
    openDocument(path, name);
  }, [openDocument]);

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
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "\\") {
        e.preventDefault();
        toggleSplit();
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
        suspendActive={onToolRoute}
      />
      <ShortcutsModal open={showShortcuts} onOpenChange={setShowShortcuts} />
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        {/* Singleton Home — visible when active tab is a home tab */}
        <div
          className="split-pane"
          data-focused={splitOn && homeVisible && focusedPane === "main" ? "" : undefined}
          onPointerDownCapture={splitOn ? () => setFocusedPane("main") : undefined}
          style={{
            position: "absolute",
            ...mainStyle,
            visibility: homeVisible ? "visible" : "hidden",
            pointerEvents: homeVisible ? "auto" : "none",
          }}
        >
          <Home onOpenPdf={handleHomePdfOpen} />
        </div>
        {/* PDF tabs stack. A tab moves between panes by style alone, so it
            never remounts and keeps its unsaved work. */}
        {openTabs.map((tab, i) => {
          if (tab.type === "home") return null;
          const inMain = i === activeTabIndex && !onToolRoute;
          const inSplit = splitOn && !mirror && tab.path === splitTab;
          const visible = inMain || inSplit;
          const pane = inSplit ? ("split" as const) : ("main" as const);
          return (
            <div
              key={tab.path}
              className="split-pane"
              data-focused={splitOn && visible && focusedPane === pane ? "" : undefined}
              onPointerDownCapture={splitOn && visible ? () => setFocusedPane(pane) : undefined}
              style={{
                position: "absolute",
                ...(inSplit ? splitStyle : mainStyle),
                visibility: visible ? "visible" : "hidden",
                pointerEvents: visible ? "auto" : "none",
              }}
            >
              <ErrorBoundary FallbackComponent={ViewerErrorFallback} key={tab.path}>
                <Viewer
                  tabPath={tab.path}
                  isActive={visible}
                  hasFocus={visible && (!splitOn || focusedPane === pane)}
                  split={splitOn}
                  pane={splitOn && visible ? pane : undefined}
                />
              </ErrorBoundary>
            </div>
          );
        })}
        {/* The active document a second time: read-only, so the two views
            can never save over each other. */}
        {mirror && splitTab && (
          <div
            key={`${splitTab}#mirror`}
            className="split-pane"
            data-focused={focusedPane === "split" ? "" : undefined}
            onPointerDownCapture={() => setFocusedPane("split")}
            style={{ position: "absolute", ...splitStyle }}
          >
            <ErrorBoundary FallbackComponent={ViewerErrorFallback}>
              <Viewer tabPath={splitTab} isActive hasFocus={focusedPane === "split"} split readOnly pane="split" />
            </ErrorBoundary>
          </div>
        )}
        {splitOn && (
          <div
            ref={paneRef}
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize split view"
            aria-valuenow={Math.round(ratio * 100)}
            title="Drag to resize. Double-click to even out."
            style={{ left: `calc(${at} - 3px)` }}
            onDoubleClick={() => { setRatio(0.5); saveRatio(0.5); }}
            onPointerDown={(e) => {
              e.preventDefault();
              const box = paneRef.current?.parentElement?.getBoundingClientRect();
              if (!box || box.width === 0) return;
              let last = ratio;
              const move = (ev: PointerEvent) => { last = clampRatio((ev.clientX - box.left) / box.width); setRatio(last); };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                document.body.classList.remove("split-resizing");
                saveRatio(last);
              };
              document.body.classList.add("split-resizing");
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
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
