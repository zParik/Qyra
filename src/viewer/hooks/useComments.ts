import { useCallback, useEffect, useRef } from "react";
import { useCommentsStore } from "../../store/useCommentsStore";
import type { Comment } from "../../store/useCommentsStore";
import { loadComments, saveComments } from "../../lib/tauri";

/**
 * Loads comments from the PDF (Text annotations + qyra sidecar) on mount and
 * auto-saves on change.
 *
 * Both load and save fully reparse the document (lopdf), which on a large
 * PDF takes seconds to tens of seconds. The rules that keep that safe:
 *
 *  1. Comments added while the initial load is still in flight are MERGED
 *     with the loaded list, never discarded — the old code replaced the
 *     store wholesale and silently ate any comment made before the (slow)
 *     load settled, then skipped saving it too.
 *  2. Never save what we just loaded — the mount echo used to rewrite every
 *     opened file just to store an unchanged list.
 *  3. Edits debounce (400ms), but `flushComments` forces the pending write
 *     and awaits it (waiting out the load first if needed). Save/close paths
 *     MUST flush — otherwise "Saved ✓" can show while the comment write is
 *     still in flight and dies with the process.
 */
export function useComments(viewerPath: string | undefined) {
  const commentsRef = useCommentsStore((s) => s.comments[viewerPath ?? ""]);
  const comments = commentsRef ?? [];
  const loadCommentsIntoStore = useCommentsStore((s) => s.loadComments);

  const saveTimerRef = useRef<number | undefined>(undefined);
  const isLoadingCommentsRef = useRef(false);
  /** Resolves when the initial load settles (success or failure). */
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  /** JSON of the last list we loaded or successfully wrote. */
  const lastSavedJsonRef = useRef<string | null>(null);
  /** JSON that still needs to reach disk (set when debounce is armed). */
  const pendingJsonRef = useRef<string | null>(null);
  /** In-flight save_comments call, if any. */
  const inFlightRef = useRef<Promise<void> | null>(null);
  const viewerPathRef = useRef(viewerPath);
  viewerPathRef.current = viewerPath;

  /** Current store list for this document, straight from the store (no
   *  React render-cycle staleness). */
  const storeJson = useCallback(() => {
    const path = viewerPathRef.current;
    if (!path) return "[]";
    return JSON.stringify(useCommentsStore.getState().comments[path] ?? []);
  }, []);

  // Load comments from the PDF once on mount.
  useEffect(() => {
    if (!viewerPath) return;
    let cancelled = false;
    isLoadingCommentsRef.current = true;
    const t0 = performance.now();
    loadPromiseRef.current = loadComments(viewerPath)
      .then((json) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) {
            console.info(
              `[comments] loaded ${parsed.length} in ${Math.round(performance.now() - t0)}ms`
            );
            lastSavedJsonRef.current = JSON.stringify(parsed);
            // Keep comments the user added while the load was in flight:
            // they exist only in the store, not in the file yet.
            const current: Comment[] =
              useCommentsStore.getState().comments[viewerPath] ?? [];
            const byId = new Map<string, Comment>(parsed.map((c: Comment) => [c.id, c]));
            for (const c of current) if (!byId.has(c.id)) byId.set(c.id, c);
            loadCommentsIntoStore(viewerPath, [...byId.values()]);
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
      .then(() => {
        const t0 = performance.now();
        return saveComments(path, json).then(() => {
          console.info(
            `[comments] saved in ${Math.round(performance.now() - t0)}ms`
          );
        });
      })
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

  // Auto-save comments whenever they actually change. While the initial load
  // is in flight we do nothing here — flushComments and the post-load merge
  // pick those changes up, so nothing is lost.
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
   * Force outstanding comment changes to disk and await them. Waits out the
   * initial load first (its merge may add local comments), then compares the
   * store against what's on disk — immune to React render-cycle timing.
   */
  const flushComments = useCallback(async (): Promise<void> => {
    clearTimeout(saveTimerRef.current);
    if (loadPromiseRef.current) await loadPromiseRef.current.catch(() => {});
    const json = storeJson();
    if (json !== (lastSavedJsonRef.current ?? "[]")) {
      pendingJsonRef.current = json;
    }
    if (pendingJsonRef.current !== null) return runPendingSave();
    return inFlightRef.current ?? Promise.resolve();
  }, [runPendingSave, storeJson]);

  /** True when comment state hasn't provably reached the disk yet. */
  const hasUnsavedComments = useCallback(() => {
    if (pendingJsonRef.current !== null || inFlightRef.current !== null) return true;
    return storeJson() !== (lastSavedJsonRef.current ?? "[]");
  }, [storeJson]);

  return {
    comments,
    isLoadingCommentsRef,
    flushComments,
    hasUnsavedComments,
  };
}
