import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

export function useOpenWithFile() {
  const navigate = useNavigate();

  const openPath = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    const s = useAppStore.getState();
    const activeTab = s.openTabs[s.activeTabIndex];

    s.setTabOriginal(path, path);
    s.setTabDirty(path, false);
    s.setTabUndo(path, null);

    if (activeTab?.type === "home") {
      s.replaceTab(s.activeTabIndex, { type: "pdf", path, name });
    } else {
      s.openTab({ type: "pdf", path, name });
    }
    navigate("/view");
  }, [navigate]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      openPath(event.payload);
    }).then((fn) => { cleanup = fn; });

    // Poll once on mount — fixes cold-start race where Rust emits before React
    // listener is registered.
    invoke<string | null>("get_pending_open").then((path) => {
      if (path) openPath(path);
    }).catch(() => {});

    // Warm-start foreground fix: when app is already resumed and onNewIntent fires,
    // MainActivity evals this DOM event so we re-drain the marker immediately.
    const onPendingOpen = () => {
      invoke<string | null>("get_pending_open").then((path) => {
        if (path) openPath(path);
      }).catch(() => {});
    };
    document.addEventListener("qyra-pending-open", onPendingOpen);

    return () => {
      cleanup?.();
      document.removeEventListener("qyra-pending-open", onPendingOpen);
    };
  }, [openPath]);
}
