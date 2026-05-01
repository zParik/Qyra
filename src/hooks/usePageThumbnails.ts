import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { sessionCache, thumbKey, thumbPrefix, thumbStoreGet, thumbStorePut, thumbStoreEvict } from "../lib/sessionCache";

// Wire up the PDF.js worker (Vite resolves ?url at build time)
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Cache the loaded PDF document per path (avoid re-loading on re-renders)
const docCache = new Map<string, pdfjsLib.PDFDocumentProxy>();

// Cache rendered thumbnails: "path:page:scale" -> data URL
const thumbCache = new Map<string, string>();

// Global render queue — ensures only one PDF.js canvas render runs at a time.
// Without this, strip (0.3x) and center (2.0x) renders compete, pegging the worker.
let renderSlotFree = true;
const renderWaiters: Array<() => void> = [];
let renderTimeoutId: ReturnType<typeof setTimeout> | null = null;

function acquireRenderSlot(): Promise<void> {
  if (renderSlotFree) {
    renderSlotFree = false;
    // Set a 30s timeout safety net in case releaseRenderSlot never gets called
    renderTimeoutId = setTimeout(() => {
      console.warn("[acquireRenderSlot] Timeout: render slot not released after 30s, forcing release");
      releaseRenderSlot();
    }, 30000);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => renderWaiters.push(resolve));
}

function releaseRenderSlot(): void {
  if (renderTimeoutId) {
    clearTimeout(renderTimeoutId);
    renderTimeoutId = null;
  }
  const next = renderWaiters.shift();
  if (next) { next(); } else { renderSlotFree = true; }
}

/** Evict all cache entries for a given path so the next render reads fresh data from disk. */
export function evictPathFromThumbnailCache(path: string) {
  docCache.delete(path);
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

export async function loadDocument(path: string): Promise<pdfjsLib.PDFDocumentProxy> {
  if (docCache.has(path)) return docCache.get(path)!;

  // Primary path: serve via asset:// so PDF.js uses HTTP range requests.
  // PDF.js fetches only the XRef table + the bytes for each rendered page on
  // demand — never loads the full file upfront. Critical for large PDFs.
  try {
    const url = convertFileSrc(path);
    const doc = await pdfjsLib.getDocument({ url }).promise;
    docCache.set(path, doc);
    return doc;
  } catch {
    // Falls through to full-buffer fallback (e.g. Android content URIs that
    // the asset protocol can't serve, or if range requests aren't supported).
    console.warn("[loadDocument] asset:// load failed, falling back to full buffer load");
  }

  // Fallback: load entire file into memory as ArrayBuffer.
  let data: ArrayBuffer | Uint8Array;
  try {
    data = await readFile(path);
  } catch {
    const { readPdfBytes } = await import("../lib/tauri");
    const base64 = await readPdfBytes(path);
    const response = await fetch(`data:application/pdf;base64,${base64}`);
    data = await response.arrayBuffer();
    console.warn("[loadDocument] readFile failed, fell back to base64 path");
  }

  const doc = await pdfjsLib.getDocument({ data }).promise;
  docCache.set(path, doc);
  return doc;
}

export async function renderPage(path: string, pageNum: number, scale: number): Promise<string> {
  const key = `${path}:${pageNum}:${scale}`;

  // Layer 1: in-memory
  if (thumbCache.has(key)) return thumbCache.get(key)!;

  // Layer 2: session cache (fast IPC, survives reloads within same session)
  const diskKey = thumbKey(path, pageNum, scale);
  const sessionHit = await sessionCache.get(diskKey);
  if (sessionHit) {
    thumbCache.set(key, sessionHit);
    return sessionHit;
  }

  // Layer 3: persistent cache (survives app restarts, keyed with file mtime)
  const persistHit = await thumbStoreGet(path, pageNum, scale);
  if (persistHit) {
    thumbCache.set(key, persistHit);
    sessionCache.put(diskKey, persistHit); // warm session cache for this run
    return persistHit;
  }

  // Layer 4: render from PDF
  await acquireRenderSlot();
  try {
    if (thumbCache.has(key)) return thumbCache.get(key)!;

    const doc = await loadDocument(path);
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const startTime = performance.now();
    await page.render({
      canvasContext: canvas.getContext("2d")!,
      viewport,
      canvas,
    }).promise;
    const renderTime = performance.now() - startTime;

    if (pageNum <= 3) {
      console.log(`[render] Page ${pageNum} at ${scale}x took ${renderTime.toFixed(0)}ms`);
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    thumbCache.set(key, dataUrl);
    sessionCache.put(diskKey, dataUrl);
    thumbStorePut(path, pageNum, scale, dataUrl); // persist for next launch (fire-and-forget)
    return dataUrl;
  } catch (e) {
    console.error(`[renderPage] Error rendering page ${pageNum}:`, e);
    throw e;
  } finally {
    releaseRenderSlot();
  }
}

/**
 * Renders a single page to raw bytes for file export.
 * Does not use the thumbnail cache — renders at the exact scale/format requested.
 */
export async function renderPageForExport(
  path: string,
  pageNum: number,
  scale: number,
  format: "png" | "jpg",
): Promise<Uint8Array> {
  const doc = await loadDocument(path);
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  await page.render({
    canvasContext: canvas.getContext("2d")!,
    viewport,
    canvas,
  }).promise;

  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  const quality = format === "jpg" ? 0.92 : undefined;

  return new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Canvas toBlob failed")); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      },
      mimeType,
      quality,
    );
  });
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
  // Stable key for visible pages to avoid re-runs when Set object changes but pages are the same
  const visibleKey = visiblePageNums
    ? Array.from(visiblePageNums).sort((a, b) => a - b).join(',')
    : '';

  // Reset when path changes
  useEffect(() => {
    activeRef.current = true;
    setThumbnails({});
    inFlightRef.current.clear();
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

      const key = `${path}:${page}:${scale}`;
      // If already in memory cache, update state synchronously
      if (thumbCache.has(key)) {
        setThumbnails((prev) => {
          if (prev[page] === thumbCache.get(key)) return prev;
          return { ...prev, [page]: thumbCache.get(key)! };
        });
        continue;
      }

      if (inFlightRef.current.has(page)) continue;

      inFlightRef.current.add(page);
      renderPage(path!, page, scale)
        .then((dataUrl) => {
          if (activeRef.current) {
            setThumbnails((prev) => ({ ...prev, [page]: dataUrl }));
          }
        })
        .catch((e) => {
          console.error(`Page ${page} render failed:`, e);
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
