import { createWorker } from "tesseract.js";
import type { Worker as TessWorker } from "tesseract.js";

export interface OcrWord {
  text: string;
  x: number;       // normalized [0, 1] from left
  y: number;       // normalized [0, 1] from top
  w: number;       // normalized width
  h: number;       // normalized height
  confidence: number;
}

export interface OcrResult {
  words: OcrWord[];
  text: string;
}

export type OcrProgressFn = (progress: number, status: string) => void;

let worker: TessWorker | null = null;
let initPromise: Promise<TessWorker> | null = null;

/** Return (or lazily create) the shared Tesseract worker. */
export async function getOcrWorker(onProgress?: OcrProgressFn): Promise<TessWorker> {
  if (worker) return worker;

  if (!initPromise) {
    initPromise = createWorker(["eng"], 1, {
      logger: (m: { status: string; progress: number }) => {
        onProgress?.(m.progress ?? 0, m.status ?? "");
      },
    }).then((w) => {
      worker = w;
      return w;
    }).catch((err) => {
      initPromise = null;
      throw err;
    });
  }

  return initPromise;
}

/**
 * Run OCR on a rendered page canvas.
 * Returns normalized word bounding boxes (0–1 relative to image dimensions).
 */
export async function ocrImage(
  image: HTMLCanvasElement,
  imageWidth: number,
  imageHeight: number,
): Promise<OcrResult> {
  const w = await getOcrWorker();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await w.recognize(image) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const words: OcrWord[] = ((data.words ?? []) as any[])
    .filter((word) => word.text?.trim().length > 0)
    .map((word) => ({
      text: word.text.trim(),
      x: word.bbox.x0 / imageWidth,
      y: word.bbox.y0 / imageHeight,
      w: (word.bbox.x1 - word.bbox.x0) / imageWidth,
      h: (word.bbox.y1 - word.bbox.y0) / imageHeight,
      confidence: word.confidence ?? 0,
    }));

  return { words, text: data.text ?? "" };
}

/** Tear down the worker (called on app unload / when no longer needed). */
export async function terminateOcrWorker(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    initPromise = null;
  }
}

// ── OCR text cache for search ─────────────────────────────────────────────
// Keyed by "path:pageNum" → extracted plain text (words joined by spaces).
// Persists for the lifetime of the session so repeated searches are instant.
const ocrTextCache = new Map<string, string>();

/**
 * Return the plain-text content of a PDF page via OCR.
 * Results are cached in memory; the first call renders + OCRs the page.
 *
 * @param path    Absolute path to the PDF file (used as cache key)
 * @param pageNum 1-based page number
 * @param pdfDoc  Already-loaded PDFDocumentProxy from PDF.js
 */
export async function getPageOcrText(
  path: string,
  pageNum: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any,
): Promise<string> {
  const key = `${path}:${pageNum}`;
  if (ocrTextCache.has(key)) return ocrTextCache.get(key)!;

  const page = await pdfDoc.getPage(pageNum);
  const scale = 2.0;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const result = await ocrImage(canvas, canvas.width, canvas.height);
  const text = result.words.map((w) => w.text).join(" ");
  ocrTextCache.set(key, text);
  return text;
}

/** Evict cached OCR text for a given file (e.g. after the file changes). */
export function evictOcrTextCache(path: string): void {
  for (const key of ocrTextCache.keys()) {
    if (key.startsWith(`${path}:`)) ocrTextCache.delete(key);
  }
}
