import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

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

    // The file Qyra was launched with ("Open with"). Rust holds it until asked,
    // so it cannot be lost to a listener that is not registered yet.
    invoke<string | null>("get_pending_open").then((path) => {
      if (path) openPath(path);
    }).catch(() => {});

    return () => {
      cleanup?.();
    };
  }, [openPath]);
}
