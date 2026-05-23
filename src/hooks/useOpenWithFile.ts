import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

export function useOpenWithFile() {
  const navigate = useNavigate();
  const openTab = useAppStore((s) => s.openTab);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() ?? path;
      openTab({ path, name });
      setTabOriginal(path, path);
      setTabDirty(path, false);
      setTabUndo(path, null);
      navigate("/view");
    }).then((fn) => { cleanup = fn; });

    return () => { cleanup?.(); };
  }, []);
}
