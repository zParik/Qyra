import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sessionCache, thumbKey, thumbPrefix, thumbStoreGet, thumbStorePut, thumbStoreEvict } from "../lib/sessionCache";
import { LruCache } from "../lib/lruCache";

// Cache rendered thumbnails: "path:page:scale" -> data URL.
// LRU-bounded: a base64 page bitmap at the center render scale is multiple MB,
// so an unbounded map let browsing/zooming a large document climb to 100% RAM.
// The session/persistent disk caches still back re-renders, so eviction here
// only costs a fast IPC read, never a re-render. The cap comfortably exceeds the
// center virtual-scroll window plus the page strip's visible range.
const THUMB_CACHE_CAP = 64;
const thumbCache = new LruCache<string>(THUMB_CACHE_CAP);

// Wait this long after the visible window stops changing before kicking off Rust
// renders. Fast/fling scrolling churns the window every frame; without this we'd
// dispatch a render for every page that flashes past, and even though each is
// cancelled the moment it leaves view, the ones that slip through flood the heap
// with multi-MB base64 (each crosses the Tauri IPC ~3x) faster than GC reclaims
// it — memory balloons mid-scroll and only settles once scrolling stops. Debouncing
// means a page must actually come to rest in the window before it costs anything.
const RENDER_DEBOUNCE_MS = 90;

/** Evict all cache entries for a given path so the next render reads fresh data from disk. */
export function evictPathFromThumbnailCache(path: string) {
  for (const key of thumbCache.keys()) {
    if (key.startsWith(`${path}:`)) thumbCache.delete(key);
  }
  sessionCache.evictPrefix(thumbPrefix(path));
  thumbStoreEvict(path); // also purge persistent cache
}

/**
 * Free ONLY the in-memory rendered bitmaps for a path (the big base64 data URLs
 * held in the WebView heap). Keeps the session/disk caches so reopening the file
 * stays fast. Call this when swapping AWAY from a document after an edit so the
 * superseded file's bitmaps don't linger in memory.
 */
export function freePathMemoryThumbnails(path: string) {
  for (const key of thumbCache.keys()) {
    if (key.startsWith(`${path}:`)) thumbCache.delete(key);
  }
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
  // Latest visible window, read by the cancel predicate so a queued render bails
  // (before it ever calls into Rust) once its page scrolls outside render distance.
  const visibleRef = useRef<Set<number>>(new Set());
  // Debounce timer for the render dispatch — reset on every window change so renders
  // only fire once scrolling settles.
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    visibleRef.current = new Set();
    if (renderTimerRef.current) { clearTimeout(renderTimerRef.current); renderTimerRef.current = null; }
    return () => {
      activeRef.current = false;
    };
  }, [path, pageCount, scale]);

  // Render visible pages on demand, and keep state pruned to the visible window.
  useEffect(() => {
    if (!path || pageCount === 0 || !visiblePageNums || visiblePageNums.size === 0) return;

    // Publish the current window for the cancel predicate of in-flight renders.
    visibleRef.current = visiblePageNums;

    const visible = Array.from(visiblePageNums)
      .filter((p) => p >= 1 && p <= pageCount)
      .sort((a, b) => a - b); // Prioritize top-to-bottom

    // Rebuild state to hold ONLY currently-visible pages — pages that scrolled
    // out of the virtual-scroll window drop their (multi-MB) base64 here so the
    // WebView heap stays bounded no matter how far you scroll or zoom out. Cache
    // hits are pulled in synchronously so re-entering a still-cached page never
    // flashes a spinner. `get` also refreshes LRU recency, keeping the visible
    // window hot and safe from eviction.
    setThumbnails((prev) => {
      const next: Record<number, string> = {};
      for (const page of visible) {
        const val = thumbCache.get(`${path}:${page}:${scale}`) ?? prev[page];
        if (val !== undefined) next[page] = val;
      }
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === Object.keys(next).length &&
          prevKeys.every((k) => prev[+k] === next[+k])) {
        return prev; // unchanged — avoid a needless re-render
      }
      return next;
    });

    // Forget bookkeeping for pages no longer visible so they re-request (and hit
    // the cache) if scrolled back to.
    for (const page of Array.from(requestedRef.current)) {
      if (!visiblePageNums.has(page)) requestedRef.current.delete(page);
    }

    // Dispatch Rust renders for uncached visible pages — but only after the window
    // stops moving. Restart the timer on every window change so flinging past a
    // page never renders it; a page must come to rest in view to cost anything.
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      renderTimerRef.current = null;
      if (!activeRef.current) return;
      // Read the settled window (the cancel predicate uses the same ref).
      for (const page of visibleRef.current) {
        if (page < 1 || page > pageCount) continue;
        if (requestedRef.current.has(page)) continue;

        const key = `${path}:${page}:${scale}`;
        if (thumbCache.has(key)) {
          // Already placed into state synchronously above.
          requestedRef.current.add(page);
          continue;
        }

        if (inFlightRef.current.has(page)) continue;

        inFlightRef.current.add(page);
        requestedRef.current.add(page); // Checklist entry: registered so we never request it twice

        // Cancel if the document changed OR the page scrolled outside the current
        // render window — checked inside renderPage before each cache layer and,
        // crucially, after the concurrency semaphore but before the Rust render, so
        // a render still rasterizes nothing once its page leaves view.
        const isCancelled = () => !activeRef.current || !visibleRef.current.has(page);

        renderPage(path!, page, scale, isCancelled)
          .then((dataUrl) => {
            // Only commit if still active AND still visible — avoids re-adding a
            // page that scrolled away while its render was in flight.
            if (activeRef.current && visibleRef.current.has(page)) {
              setThumbnails((prev) => ({ ...prev, [page]: dataUrl }));
            }
          })
          .catch((e) => {
            // Cancellation is expected (page scrolled away) — not an error. Drop it
            // from the checklist so it re-renders if it scrolls back into view.
            requestedRef.current.delete(page);
            if (activeRef.current && String(e?.message ?? e) !== "Cancelled") {
              console.error(`Page ${page} render failed:`, e);
            }
          })
          .finally(() => {
            inFlightRef.current.delete(page);
          });
      }
    }, RENDER_DEBOUNCE_MS);
  // visibleKey is the stable string proxy for visiblePageNums — depending on the
  // Set itself would re-run on every identity change even when the pages are equal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
