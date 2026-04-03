import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { readPdfBytes } from "../lib/tauri";

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
      }
    }
  }
}

export async function loadDocument(path: string): Promise<pdfjsLib.PDFDocumentProxy> {
  if (docCache.has(path)) return docCache.get(path)!;

  const base64 = await readPdfBytes(path);

  // Decode base64 via fetch — browser-native and non-blocking.
  // The old charCodeAt loop over 90M+ bytes was synchronous and froze the UI.
  const response = await fetch(`data:application/pdf;base64,${base64}`);
  const buffer = await response.arrayBuffer();

  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  docCache.set(path, doc);
  return doc;
}

export async function renderPage(path: string, pageNum: number, scale: number): Promise<string> {
  const key = `${path}:${pageNum}:${scale}`;
  if (thumbCache.has(key)) return thumbCache.get(key)!;

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
 * Renders thumbnails for all pages of a single PDF using PDF.js.
 * Pages render sequentially so page 1 appears immediately; later pages fill in progressively.
 */
export function usePageThumbnails(path: string | null, pageCount: number, scale = 1.2) {
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
