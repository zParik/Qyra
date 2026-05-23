import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore, TabEntry } from "../store/useAppStore";
import { TabBar } from "./TabBar";
import Viewer from "./Viewer";
import { ErrorBoundary } from "react-error-boundary";
import { ViewerErrorFallback } from "../components/ErrorFallback";

export default function ViewerShell() {
  const navigate = useNavigate();
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const activateTab = useAppStore((s) => s.activateTab);
  const tabDirty = useAppStore((s) => s.tabDirty);

  // Load persisted session on first mount (only if no tabs already open)
  useEffect(() => {
    if (openTabs.length > 0) return;
    invoke<[TabEntry[], number]>("get_tab_session").then(([tabs, active]) => {
      if (tabs.length === 0) { navigate("/"); return; }
      tabs.forEach((t) => openTab(t));
      activateTab(active);
    }).catch(() => navigate("/"));
  }, []);

  // Persist session whenever tabs or active index change
  useEffect(() => {
    if (openTabs.length === 0) return;
    invoke("save_tab_session", {
      tabs: openTabs.map((t) => ({ path: t.path, name: t.name })),
      activeIndex: activeTabIndex,
    }).catch(console.error);
  }, [openTabs, activeTabIndex]);

  // Persist session on page unload
  useEffect(() => {
    const handler = () => {
      if (openTabs.length === 0) return;
      invoke("save_tab_session", {
        tabs: openTabs.map((t) => ({ path: t.path, name: t.name })),
        activeIndex: activeTabIndex,
      });
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [openTabs, activeTabIndex]);

  const handleOpenFile = useCallback(async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : (selected as string[])[0];
    if (!path) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    openTab({ path, name });
  }, [openTab]);

  const handleCloseTab = useCallback((index: number) => {
    const tab = openTabs[index];
    if (tab && tabDirty[tab.path]) {
      if (!confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
    }
    closeTab(index);
    if (openTabs.length <= 1) {
      invoke("clear_tab_session").catch(console.error);
      navigate("/");
    }
  }, [openTabs, tabDirty, closeTab, navigate]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        handleOpenFile();
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabIndex, openTabs.length, handleOpenFile, handleCloseTab, activateTab]);

  if (openTabs.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <TabBar
        onOpenFile={handleOpenFile}
        onCloseTab={handleCloseTab}
        onOpenExternalFile={(path, name) => openTab({ path, name })}
      />
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        {openTabs.map((tab, i) => (
          <div
            key={tab.path}
            style={{
              position: "absolute",
              inset: 0,
              visibility: i === activeTabIndex ? "visible" : "hidden",
              pointerEvents: i === activeTabIndex ? "auto" : "none",
            }}
          >
            <ErrorBoundary FallbackComponent={ViewerErrorFallback} key={tab.path}>
              <Viewer tabPath={tab.path} />
            </ErrorBoundary>
          </div>
        ))}
      </div>
    </div>
  );
}
