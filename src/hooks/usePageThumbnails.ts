import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sessionCache, thumbKey, thumbPrefix, thumbStoreGet, thumbStorePut, thumbStoreEvict } from "../lib/sessionCache";

// Cache rendered thumbnails: "path:page:scale" -> data URL
const thumbCache = new Map<string, string>();

/** Evict all cache entries for a given path so the next render reads fresh data from disk. */
export function evictPathFromThumbnailCache(path: string) {
  for (const key of thumbCache.keys()) {
    if (key.startsWith(`${path}:`)) thumbCache.delete(key);
  }
  sessionCache.evictPrefix(thumbPrefix(path));
  thumbStoreEvict(path); // also purge persistent cache
}

/**
 * Pre-populate the thumbnail cache for a reordered PDF by copying entries from the
 * original path. Since reorder only repositions pages without changing content, each
 * thumbnail is identical — just at a new position. This makes the post-apply reload
 * instant (all cache hits) instead of re-rendering every page from scratch.
 *
 * @param oldPath  - original PDF path
 * @param newPath  - reordered temp PDF path
 * @param order    - order[i] is the 1-indexed old page number that now sits at position i+1
 * @param scales   - the scale values to seed (should match what usePageThumbnails uses)
 */
export function seedThumbnailsForReorder(
  oldPath: string,
  newPath: string,
  order: number[],
  scales: number[],
) {
  for (const scale of scales) {
    for (let newPos = 1; newPos <= order.length; newPos++) {
      const oldPageNum = order[newPos - 1];
      const cached = thumbCache.get(`${oldPath}:${oldPageNum}:${scale}`);
      if (cached) {
        thumbCache.set(`${newPath}:${newPos}:${scale}`, cached);
        // Also seed the disk cache (fire-and-forget)
        sessionCache.put(thumbKey(newPath, newPos, scale), cached);
      }
    }
  }
}

class SimpleSemaphore {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.activeCount--;
    if (this.queue.length > 0) {
      this.activeCount++;
      const next = this.queue.shift();
      next?.();
    }
  }
}

const renderSemaphore = new SimpleSemaphore(2); // Limit concurrent renders to 2

export async function renderPage(
  path: string,
  pageNum: number,
  scale: number,
  isCancelled?: () => boolean,
): Promise<string> {
  const key = `${path}:${pageNum}:${scale}`;

  // Layer 1: in-memory
  if (thumbCache.has(key)) return thumbCache.get(key)!;

  // Layer 2: session cache (fast IPC, survives reloads within same session)
  if (isCancelled?.()) throw new Error("Cancelled");
  const diskKey = thumbKey(path, pageNum, scale);
  const sessionHit = await sessionCache.get(diskKey);
  if (sessionHit) {
    thumbCache.set(key, sessionHit);
    return sessionHit;
  }

  // Layer 3: persistent cache (survives app restarts, keyed with file mtime)
  if (isCancelled?.()) throw new Error("Cancelled");
  const persistHit = await thumbStoreGet(path, pageNum, scale);
  if (persistHit) {
    thumbCache.set(key, persistHit);
    sessionCache.put(diskKey, persistHit);
    return persistHit;
  }

  // Layer 4: render via MuPDF in Rust (runs in tokio spawn_blocking — no WebView freeze)
  if (isCancelled?.()) throw new Error("Cancelled");
  await renderSemaphore.acquire();
  try {
    if (isCancelled?.()) throw new Error("Cancelled");
    const base64 = await invoke<string>("render_page", { path, page: pageNum, scale });
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    thumbCache.set(key, dataUrl);
    sessionCache.put(diskKey, dataUrl);
    thumbStorePut(path, pageNum, scale, dataUrl);
    return dataUrl;
  } finally {
    renderSemaphore.release();
  }
}

/**
 * Renders a single page to raw bytes for file export via MuPDF (Rust).
 * Does not use the thumbnail cache — renders at the exact scale/format requested.
 */
export async function renderPageForExport(
  path: string,
  pageNum: number,
  scale: number,
  _format: "png" | "jpg",
): Promise<Uint8Array> {
  // render_page always returns JPEG; for PNG export fall back to high-quality JPEG
  const base64 = await invoke<string>("render_page", { path, page: pageNum, scale });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * LAZY thumbnail hook — only renders pages whose IDs appear in `visiblePageNums`.
 * Pages that scroll out of view keep their cached thumbnail (no re-render needed).
 *
 * This is the primary hook used by the Viewer's center pane.
 */
export function usePageThumbnails(
  path: string | null,
  pageCount: number,
  scale: number,
  visiblePageNums?: Set<number>,
) {
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const activeRef = useRef(true);
  // Track in-flight renders to avoid duplicate work
  const inFlightRef = useRef<Set<number>>(new Set());
  // Checklist tracker to remember what has already been requested/finished to avoid duplicate processing
  const requestedRef = useRef<Set<number>>(new Set());
  // Stable key for visible pages to avoid re-runs when Set object changes but pages are the same
  const visibleKey = visiblePageNums
    ? Array.from(visiblePageNums).sort((a, b) => a - b).join(',')
    : '';

  // Reset when path changes
  useEffect(() => {
    activeRef.current = true;
    setThumbnails({});
    inFlightRef.current.clear();
    requestedRef.current.clear();
    return () => {
      activeRef.current = false;
    };
  }, [path, pageCount, scale]);

  // Render visible pages on demand
  useEffect(() => {
    if (!path || pageCount === 0 || !visiblePageNums || visiblePageNums.size === 0) return;

    const pagesRequested = Array.from(visiblePageNums!)
      .sort((a, b) => a - b); // Prioritize top-to-bottom

    // Queue all visible pages for rendering (render slot serializes the actual rendering)
    for (const page of pagesRequested) {
      if (page < 1 || page > pageCount) continue;

      // Skip instantly if this page has already been requested/rendered
      if (requestedRef.current.has(page)) continue;

      const key = `${path}:${page}:${scale}`;
      // If already in memory cache, update state synchronously and mark as requested
      if (thumbCache.has(key)) {
        requestedRef.current.add(page);
        setThumbnails((prev) => {
          if (prev[page] === thumbCache.get(key)) return prev;
          return { ...prev, [page]: thumbCache.get(key)! };
        });
        continue;
      }

      if (inFlightRef.current.has(page)) continue;

      inFlightRef.current.add(page);
      requestedRef.current.add(page); // Checklist entry: registered as requested so we never request it again

      renderPage(path!, page, scale, () => !activeRef.current)
        .then((dataUrl) => {
          if (activeRef.current) {
            setThumbnails((prev) => ({ ...prev, [page]: dataUrl }));
          }
        })
        .catch((e) => {
          if (activeRef.current) {
            console.error(`Page ${page} render failed:`, e);
            // On failure, remove from requested list so it can be retried if it becomes visible again
            requestedRef.current.delete(page);
          }
        })
        .finally(() => {
          inFlightRef.current.delete(page);
        });
    }
  }, [path, pageCount, scale, visibleKey]);

  return thumbnails;
}

/**
 * Eager thumbnail hook — renders ALL pages sequentially (original behavior).
 * Used by PageStrip where all thumbnails eventually need to be generated
 * but are small (0.3x scale).  Still renders progressively so page 1 appears
 * first.
 */
export function usePageThumbnailsEager(path: string | null, pageCount: number, scale = 1.2) {
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const activeRef = useRef(true);

  useEffect(() => {
    if (!path || pageCount === 0) {
      setThumbnails({});
      return;
    }

    activeRef.current = true;
    setThumbnails({});

    async function load() {
      for (let page = 1; page <= pageCount; page++) {
        if (!activeRef.current) break;
        try {
          const dataUrl = await renderPage(path!, page, scale);
          if (activeRef.current) {
            setThumbnails((prev) => ({ ...prev, [page]: dataUrl }));
          }
        } catch (e) {
          console.error(`Page ${page} render failed:`, e);
        }
      }
    }

    load();
    return () => {
      activeRef.current = false;
    };
  }, [path, pageCount, scale]);

  return thumbnails;
}
