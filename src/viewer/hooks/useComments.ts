import { useCallback, useEffect, useRef } from "react";
import { useCommentsStore } from "../../store/useCommentsStore";
import { loadComments, saveComments } from "../../lib/tauri";

/**
 * Loads comments from the PDF (Text annotations + qyra sidecar) on mount and
 * auto-saves on change.
 *
 * Saving rewrites the whole document (lopdf parse + save), which on a large
 * PDF takes seconds. Three rules keep that safe and cheap:
 *
 *  1. Never save what we just loaded — the mount echo used to rewrite every
 *     opened file just to store an unchanged list.
 *  2. Debounce edits (400ms), but track the pending state.
 *  3. Expose `flushComments` so Save/close paths can force the pending write
 *     NOW and await it — otherwise "Saved ✓" can show while the comment save
 *     is still in flight and dies with the process.
 */
export function useComments(viewerPath: string | undefined) {
  const commentsRef = useCommentsStore((s) => s.comments[viewerPath ?? ""]);
  const comments = commentsRef ?? [];
  const loadCommentsIntoStore = useCommentsStore((s) => s.loadComments);

  const saveTimerRef = useRef<number | undefined>(undefined);
  const isLoadingCommentsRef = useRef(false);
  /** JSON of the last list we loaded or successfully queued for save. */
  const lastSavedJsonRef = useRef<string | null>(null);
  /** JSON that still needs to reach disk (set when debounce is armed). */
  const pendingJsonRef = useRef<string | null>(null);
  /** In-flight save_comments call, if any. */
  const inFlightRef = useRef<Promise<void> | null>(null);
  const viewerPathRef = useRef(viewerPath);
  viewerPathRef.current = viewerPath;

  // Load comments from the PDF once on mount.
  useEffect(() => {
    if (!viewerPath) return;
    let cancelled = false;
    isLoadingCommentsRef.current = true;
    loadComments(viewerPath)
      .then((json) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) {
            lastSavedJsonRef.current = JSON.stringify(parsed);
            loadCommentsIntoStore(viewerPath, parsed);
          }
        } catch {
          /* ignore malformed JSON */
        }
      })
      .catch((e) => {
        // File might legitimately have no comments yet, but a real failure
        // here means comments silently never load — surface it.
        console.error("[comments] load failed:", e);
      })
      .finally(() => {
        if (!cancelled) isLoadingCommentsRef.current = false;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: original path == viewerPath at this point

  /** Run the actual save for whatever is pending. Chains onto any in-flight
   *  save so two writers never race on the same file. */
  const runPendingSave = useCallback((): Promise<void> => {
    const path = viewerPathRef.current;
    const json = pendingJsonRef.current;
    if (!path || json === null) return inFlightRef.current ?? Promise.resolve();
    pendingJsonRef.current = null;

    const prev = inFlightRef.current ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => saveComments(path, json))
      .then(() => {
        lastSavedJsonRef.current = json;
      })
      .catch((e) => {
        // A silent failure here loses the user's comments on disk.
        console.error("[comments] save failed:", e);
        throw e;
      })
      .finally(() => {
        if (inFlightRef.current === run) inFlightRef.current = null;
      });
    inFlightRef.current = run;
    return run;
  }, []);

  // Auto-save comments whenever they actually change.
  useEffect(() => {
    if (!viewerPath || isLoadingCommentsRef.current) return;
    const json = JSON.stringify(comments);
    // Mount echo / no-op change: nothing new to write. Without this, every
    // opened PDF was fully rewritten just to store the list we read from it.
    if (json === lastSavedJsonRef.current && pendingJsonRef.current === null) return;
    pendingJsonRef.current = json;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void runPendingSave().catch(() => {});
    }, 400);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, viewerPath]);

  /**
   * Force any pending/in-flight comment save to disk and await it. Save and
   * close paths MUST call this before reporting success — resolves
   * immediately when there is nothing to write.
   */
  const flushComments = useCallback((): Promise<void> => {
    clearTimeout(saveTimerRef.current);
    if (pendingJsonRef.current !== null) return runPendingSave();
    return inFlightRef.current ?? Promise.resolve();
  }, [runPendingSave]);

  /** True while a comment save is pending or in flight. */
  const hasUnsavedComments = useCallback(
    () => pendingJsonRef.current !== null || inFlightRef.current !== null,
    []
  );

  return {
    comments,
    isLoadingCommentsRef,
    flushComments,
    hasUnsavedComments,
  };
}
