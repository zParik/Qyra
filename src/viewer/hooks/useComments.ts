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
      .catch(() => {
        /* file might not have comments yet */
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
      saveComments(viewerPath, JSON.stringify(comments)).catch(() => {});
    }, 400);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, viewerPath]);

  return {
    comments,
    isLoadingCommentsRef,
  };
}
