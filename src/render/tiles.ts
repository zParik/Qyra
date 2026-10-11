// Tile maths, mirrored from src-tauri/src/render/geometry.rs — keep in sync.
import { PT_TO_CSS, type PageSize } from "./layout";

export const TILE = 512;

export const renderScale = (zoom: number, dpr: number): number => zoom * PT_TO_CSS * dpr;

/** Device-pixel page size: ceil(pt * scale - 1e-6), min 1 (same as Rust page_px). */
export function pagePx(size: PageSize, scale: number): { w: number; h: number } {
  const px = (pt: number) => Math.max(1, Math.ceil(pt * scale - 1e-6));
  return { w: px(size.w), h: px(size.h) };
}

export type TileXY = { tx: number; ty: number };
export type RectPx = { x0: number; y0: number; x1: number; y1: number };

/** Tiles of a `px`-sized page that intersect `r` (device px), row-major. */
export function tilesInRect(px: { w: number; h: number }, r: RectPx): TileXY[] {
  const cols = Math.ceil(px.w / TILE);
  const rows = Math.ceil(px.h / TILE);
  const tx0 = Math.max(0, Math.floor(r.x0 / TILE));
  const ty0 = Math.max(0, Math.floor(r.y0 / TILE));
  const tx1 = Math.min(cols - 1, Math.floor((r.x1 - 1) / TILE));
  const ty1 = Math.min(rows - 1, Math.floor((r.y1 - 1) / TILE));
  const out: TileXY[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push({ tx, ty });
  return out;
}

export function tileRectPx(px: { w: number; h: number }, t: TileXY): RectPx {
  const x0 = t.tx * TILE;
  const y0 = t.ty * TILE;
  return { x0, y0, x1: Math.min(x0 + TILE, px.w), y1: Math.min(y0 + TILE, px.h) };
}
