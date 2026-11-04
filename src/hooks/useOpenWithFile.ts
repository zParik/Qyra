import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

/**
 * Open files sent by "Open with" while Qyra is running (the single-instance
 * plugin forwards them as `open-pdf`). The file Qyra was launched with is
 * opened by ViewerShell once the saved session is restored.
 */
export function useOpenWithFile() {
  const navigate = useNavigate();

  const openPath = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    useAppStore.getState().openDocument(path, name);
    navigate("/view");
  }, [navigate]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      openPath(event.payload);
    }).then((fn) => { cleanup = fn; });

    return () => {
      cleanup?.();
    };
  }, [openPath]);
}
