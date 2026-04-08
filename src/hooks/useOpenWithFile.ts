import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

/**
 * Listens for the "open-pdf" event emitted by the Rust backend when the app
 * is launched via "Open with" or double-click on a PDF file. Navigates to the
 * viewer immediately — page count and full info populate lazily via Viewer's effect.
 */
export function useOpenWithFile() {
  const navigate = useNavigate();
  const setViewerFile = useAppStore((s) => s.setViewerFile);
  const setOriginalViewerPath = useAppStore((s) => s.setOriginalViewerPath);
  const setIsViewerDirty = useAppStore((s) => s.setIsViewerDirty);
  const setUndoViewerFile = useAppStore((s) => s.setUndoViewerFile);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() ?? path;
      // Navigate immediately — info loads in the background via Viewer's lazy effect
      setViewerFile({ path, name });
      setOriginalViewerPath(path);
      setIsViewerDirty(false);
      setUndoViewerFile(null);
      navigate("/view");
    }).then((fn) => {
      cleanup = fn;
    });

    return () => {
      cleanup?.();
    };
  }, []);
}
