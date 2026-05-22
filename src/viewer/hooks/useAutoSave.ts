import { useEffect, useRef, useState } from "react";
import { getSetting, setSetting } from "../../lib/tauri";

/**
 * Auto-save preference, persisted to SQLite. Also exposes the debounce
 * timers used by Viewer for queued auto-save and "saved" toast feedback.
 *
 * The `autoSaveRef` is kept in sync so non-React callbacks (timeouts) read
 * the latest value without depending on a stale closure.
 */
export function useAutoSave() {
  const [autoSave, setAutoSave] = useState<boolean>(false);
  const autoSaveRef = useRef<boolean>(autoSave);
  const autoSaveTimerRef = useRef<number | undefined>(undefined);
  const savedFeedbackTimerRef = useRef<number | undefined>(undefined);

  // Load auto-save preference from SQLite on mount.
  useEffect(() => {
    getSetting("auto_save")
      .then((val) => {
        if (val !== null) setAutoSave(val === "1");
      })
      .catch(() => {});
  }, []);

  // Keep ref in sync and persist to SQLite on change.
  useEffect(() => {
    autoSaveRef.current = autoSave;
    setSetting("auto_save", autoSave ? "1" : "0").catch(() => {});
  }, [autoSave]);

  return {
    autoSave,
    setAutoSave,
    autoSaveRef,
    autoSaveTimerRef,
    savedFeedbackTimerRef,
  };
}
