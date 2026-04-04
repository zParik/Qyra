import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { sessionCache, thumbKey, thumbPrefix } from "../lib/sessionCache";

// Wire up the PDF.js worker (Vite resolves ?url at build time)
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Cache the loaded PDF document per path (avoid re-loading on re-renders)
const docCache = new Map<string, pdfjsLib.PDFDocumentProxy>();

// Cache rendered thumbnails: "path:page:scale" -> data URL
const thumbCache = new Map<string, string>();

/** Evict all cache entries for a given path so the next render reads fresh data from disk. */
export function evictPathFromThumbnailCache(path: string) {
  docCache.delete(path);
  for (const key of thumbCache.keys()) {
    if (key.startsWith(`${path}:`)) thumbCache.delete(key);
  }
  // Also evict from the disk-backed session cache
  sessionCache.evictPrefix(thumbPrefix(path));
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

  let data: ArrayBuffer | Uint8Array;

  try {
    // Prefer Tauri plugin-fs readFile — binary IPC, no base64 overhead.
    data = await readFile(path);
  } catch {
    // Fallback: readPdfBytes via invoke (base64 encoded — slower, higher memory).
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
  if (thumbCache.has(key)) return thumbCache.get(key)!;

  // Check the disk-backed session cache before doing expensive PDF rendering
  const diskKey = thumbKey(path, pageNum, scale);
  const diskHit = await sessionCache.get(diskKey);
  if (diskHit) {
    thumbCache.set(key, diskHit);
    return diskHit;
  }

  const doc = await loadDocument(path);
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({
    canvasContext: canvas.getContext("2d")!,
    viewport,
    canvas,
  }).promise;

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  thumbCache.set(key, dataUrl);
  // Write-through: persist to disk cache (fire-and-forget)
  sessionCache.put(diskKey, dataUrl);
  return dataUrl;
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
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

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

    let cancelled = false;

    async function renderVisible() {
      // Sort so pages render top-to-bottom
      const pages = Array.from(visiblePageNums!).sort((a, b) => a - b);

      for (const page of pages) {
        if (cancelled || !activeRef.current) break;
        if (page < 1 || page > pageCount) continue;

        // Already rendered or in flight
        const key = `${path}:${page}:${scale}`;
        if (thumbnails[page]) continue; // already in state — skip to avoid infinite loop
        if (thumbCache.has(key)) {
          // Cache hit — just update state
          setThumbnails((prev) => ({ ...prev, [page]: thumbCache.get(key)! }));
          continue;
        }
        if (inFlightRef.current.has(page)) continue;

        inFlightRef.current.add(page);
        try {
          const dataUrl = await renderPage(path!, page, scale);
          if (!cancelled && activeRef.current) {
            setThumbnails((prev) => ({ ...prev, [page]: dataUrl }));
          }
        } catch (e) {
          console.error(`Page ${page} render failed:`, e);
        } finally {
          inFlightRef.current.delete(page);
        }
      }
    }

    renderVisible();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pageCount, scale, visiblePageNums]);

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
