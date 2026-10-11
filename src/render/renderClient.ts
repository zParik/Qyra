// Thin client over the Rust render service. Pixels arrive as raw RGBA
// (8-byte LE header w,h + pixels) — no JPEG, no base64.
import { invoke } from "@tauri-apps/api/core";
import type { PageSize } from "./layout";

export type DocInfo = { pageCount: number; pages: PageSize[]; version: string };
export type Rgba = { w: number; h: number; pixels: Uint8ClampedArray };
export type Priority = "visible" | "preview" | "prefetch";

export const docOpen = (path: string) => invoke<DocInfo>("doc_open", { path });

export function decodeRgba(buf: ArrayBuffer): Rgba | null {
  if (buf.byteLength < 8) return null;
  const v = new DataView(buf);
  const w = v.getUint32(0, true);
  const h = v.getUint32(4, true);
  if (w === 0 || h === 0) return null;
  return { w, h, pixels: new Uint8ClampedArray(buf, 8, w * h * 4) };
}

// Frontend ids stay below 2^52 (Rust's internal ids start there).
let nextId = 1;

// Cancels are batched: an abort storm during a fling becomes one IPC call.
let pendingCancels: number[] = [];
let cancelTimer: ReturnType<typeof setTimeout> | null = null;
function queueCancel(id: number) {
  pendingCancels.push(id);
  if (cancelTimer) return;
  cancelTimer = setTimeout(() => {
    const ids = pendingCancels;
    pendingCancels = [];
    cancelTimer = null;
    invoke("cancel_renders", { ids }).catch(() => {});
  }, 16);
}

/** One tile as RGBA, or null when cancelled / outside the page. Never rejects on abort. */
export async function renderTile(
  req: { path: string; page: number; scale: number; tx: number; ty: number; priority: Priority },
  signal?: AbortSignal,
): Promise<Rgba | null> {
  if (signal?.aborted) return null;
  const id = nextId++;
  const onAbort = () => queueCancel(id);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const buf = await invoke<ArrayBuffer>("render_tile", { req: { ...req, id } });
    return signal?.aborted ? null : decodeRgba(buf);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A whole page as RGBA (OCR, print). */
export async function renderPageRgba(path: string, page: number, scale: number): Promise<Rgba | null> {
  return decodeRgba(await invoke<ArrayBuffer>("render_page_rgba", { path, page, scale }));
}

/** Draw decoded RGBA into a fresh canvas of the same size (OCR input, print). */
export function rgbaToCanvas(rgba: Rgba): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = rgba.w;
  canvas.height = rgba.h;
  canvas.getContext("2d")?.putImageData(new ImageData(rgba.pixels, rgba.w, rgba.h), 0, 0);
  return canvas;
}

const isWindows = () => typeof navigator !== "undefined" && /win/i.test(navigator.platform);

/** `<img src>` for a lossless page thumbnail served by the `qyra` URI scheme. */
export function thumbUrl(path: string, page: number, width: 128 | 256 | 512, version = ""): string {
  const base = isWindows() ? "http://qyra.localhost" : "qyra://localhost";
  return `${base}/thumb/${page}?path=${encodeURIComponent(path)}&w=${width}&v=${encodeURIComponent(version)}`;
}
