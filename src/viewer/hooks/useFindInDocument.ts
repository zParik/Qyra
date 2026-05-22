import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type FindMatch = { page: number };
export type OcrProgress = { page: number; total: number };

/**
 * Find-in-document state and search effects. Runs a MuPDF text search via
 * Tauri whenever the query changes and auto-scrolls to the active match.
 */
export function useFindInDocument(
  viewerPath: string | undefined,
  pageCount: number,
  scrollToPage: (page: number) => void,
) {
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findQuery, setFindQuery] = useState<string>("");
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const [findCurrentIdx, setFindCurrentIdx] = useState<number>(0);
  const [ocrSearching, setOcrSearching] = useState<boolean>(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | undefined>(undefined);

  // Search pages — PDF text first, then OCR automatically if no text matches.
  useEffect(() => {
    if (!findQuery.trim() || !viewerPath || pageCount === 0) {
      setFindMatches([]);
      setFindCurrentIdx(0);
      setOcrSearching(false);
      setOcrProgress(undefined);
      return;
    }
    let cancelled = false;
    setOcrSearching(false);
    setOcrProgress(undefined);

    async function search() {
      try {
        type SearchHit = { page: number; count: number };
        const hits = await invoke<SearchHit[]>("search_pdf", {
          path: viewerPath,
          query: findQuery.trim(),
        });
        if (cancelled) return;

        if (hits.length > 0) {
          const textMatches = hits.flatMap((h) =>
            Array.from({ length: h.count }, () => ({ page: h.page })),
          );
          setFindMatches(textMatches);
          setFindCurrentIdx(0);
          return;
        }

        setFindMatches([]);
        setFindCurrentIdx(0);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) {
          setOcrSearching(false);
          setOcrProgress(undefined);
        }
      }
    }

    search();
    return () => {
      cancelled = true;
    };
  }, [findQuery, viewerPath, pageCount]);

  // Navigate to current find match page.
  useEffect(() => {
    if (findMatches.length === 0) return;
    const match = findMatches[findCurrentIdx];
    if (match) scrollToPage(match.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findCurrentIdx, findMatches]);

  return {
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    findMatches,
    setFindMatches,
    findCurrentIdx,
    setFindCurrentIdx,
    ocrSearching,
    ocrProgress,
  };
}
