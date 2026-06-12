import { useEffect, useRef } from "react";
import { useCommentsStore } from "../../store/useCommentsStore";
import { loadComments, saveComments } from "../../lib/tauri";

/**
 * Loads comments from the embedded PDF attachment on mount, auto-saves on
 * change, and exposes the refs/state previously held inline in Viewer.tsx.
 */
export function useComments(viewerPath: string | undefined) {
  const commentsRef = useCommentsStore((s) => s.comments[viewerPath ?? ""]);
  const comments = commentsRef ?? [];
  const loadCommentsIntoStore = useCommentsStore((s) => s.loadComments);

  const saveTimerRef = useRef<number | undefined>(undefined);
  const isLoadingCommentsRef = useRef(false);

  // Load comments from embedded PDF attachment once on mount.
  useEffect(() => {
    if (!viewerPath) return;
    let cancelled = false;
    isLoadingCommentsRef.current = true;
    loadComments(viewerPath)
      .then((json) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) loadCommentsIntoStore(viewerPath, parsed);
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

  // Auto-save comments to the current working PDF whenever they change.
  useEffect(() => {
    if (!viewerPath || isLoadingCommentsRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveComments(viewerPath, JSON.stringify(comments)).catch((e) => {
        // A silent failure here loses the user's comments on disk.
        console.error("[comments] save failed:", e);
      });
    }, 400);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, viewerPath]);

  return {
    comments,
    isLoadingCommentsRef,
  };
}
