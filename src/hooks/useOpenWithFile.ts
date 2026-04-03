import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { getPdfInfo } from "../lib/tauri";

/**
 * Listens for the "open-pdf" event emitted by the Rust backend when the app
 * is launched via "Open with" or double-click on a PDF file. Loads the file
 * and navigates to the viewer.
 */
export function useOpenWithFile() {
  const navigate = useNavigate();
  const setViewerFile = useAppStore((s) => s.setViewerFile);
  const setOriginalViewerPath = useAppStore((s) => s.setOriginalViewerPath);
  const setIsViewerDirty = useAppStore((s) => s.setIsViewerDirty);
  const setUndoViewerFile = useAppStore((s) => s.setUndoViewerFile);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", async (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() ?? path;
      try {
        const info = await getPdfInfo(path);
        setViewerFile({ path, name, info });
      } catch {
        setViewerFile({ path, name });
      }
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
