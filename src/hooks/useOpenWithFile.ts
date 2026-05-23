import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

export function useOpenWithFile() {
  const navigate = useNavigate();

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      const path = event.payload;
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
    }).then((fn) => { cleanup = fn; });

    return () => { cleanup?.(); };
  }, []);
}
