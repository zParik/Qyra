// One page: lossless preview <img> (instant, possibly blurry) under exact-
// device-pixel tile canvases, under the overlay children. Tiles are placed in
// PERCENT of the page box, so tiles from a previous zoom keep lining up
// (stretched) until their replacements land — no blank flash on zoom.
import React, { useEffect, useRef, useState } from "react";
import { PT_TO_CSS, type PageSize } from "../render/layout";
import { pagePx, renderScale, tileRectPx, tilesInRect, type RectPx } from "../render/tiles";
import { renderTile, thumbUrl } from "../render/renderClient";
import { tileCache, tileKey } from "../render/tileCache";

/** Wait for the visible window to settle before requesting tiles. */
const SETTLE_MS = 80;

type Props = {
  path: string;
  version: string;
  page: number;
  sizePt: PageSize;
  zoom: number;
  dpr: number;
  /** Visible part of this page in page-box CSS px; null → preview only. */
  visibleCss: RectPx | null;
  onError?: (page: number) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function PageView({ path, version, page, sizePt, zoom, dpr, visibleCss, onError, className, style, children }: Props) {
  const cssW = sizePt.w * PT_TO_CSS * zoom;
  const cssH = sizePt.h * PT_TO_CSS * zoom;
  const tileLayer = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const scale = renderScale(zoom, dpr);
  const px = pagePx(sizePt, scale);

  // Visible rect → device px; the wanted set adds one viewport of margin on
  // every side so a short scroll finds its tiles already rendered.
  const toPx = (r: RectPx, m: number): RectPx => ({
    x0: (r.x0 - m) * dpr,
    y0: (r.y0 - m) * dpr,
    x1: (r.x1 + m) * dpr,
    y1: (r.y1 + m) * dpr,
  });
  const margin = visibleCss ? Math.max(visibleCss.y1 - visibleCss.y0, visibleCss.x1 - visibleCss.x0) : 0;
  const wanted = visibleCss ? tilesInRect(px, toPx(visibleCss, margin)) : [];
  const visibleTiles = new Set(
    visibleCss ? tilesInRect(px, toPx(visibleCss, 0)).map((t) => `${t.tx},${t.ty}`) : [],
  );
  // Quantized to tiles so small scrolls don't re-run the effect.
  const wantedKey = wanted.map((t) => `${t.tx},${t.ty}`).join(";");

  useEffect(() => {
    const layer = tileLayer.current;
    if (!layer || wanted.length === 0) return;
    const ctl = new AbortController();
    const keysNow = new Set<string>();
    const scaleTag = String(scale);

    const attach = (canvas: HTMLCanvasElement, key: string, r: RectPx) => {
      canvas.dataset.scale = scaleTag;
      canvas.dataset.key = key;
      Object.assign(canvas.style, {
        position: "absolute",
        left: `${(r.x0 / px.w) * 100}%`,
        top: `${(r.y0 / px.h) * 100}%`,
        width: `${((r.x1 - r.x0) / px.w) * 100}%`,
        height: `${((r.y1 - r.y0) / px.h) * 100}%`,
      });
      if (canvas.parentElement !== layer) layer.appendChild(canvas);
    };

    // Once every wanted tile at the current scale is attached, drop the rest
    // (stale-zoom tiles and tiles that left the window).
    const sweepStale = () => {
      const current = Array.from(layer.children).filter(
        (c) => (c as HTMLElement).dataset.scale === scaleTag,
      );
      if (current.length < wanted.length) return;
      for (const c of Array.from(layer.children)) {
        const el = c as HTMLCanvasElement;
        if (el.dataset.scale !== scaleTag || !keysNow.has(el.dataset.key ?? "")) el.remove();
      }
    };

    const timer = setTimeout(() => {
      for (const t of wanted) {
        const key = tileKey(path, version, page, scale, t.tx, t.ty);
        keysNow.add(key);
        const r = tileRectPx(px, t);
        const hit = tileCache.get(key);
        if (hit) {
          attach(hit, key, r);
          continue;
        }
        const priority = visibleTiles.has(`${t.tx},${t.ty}`) ? "visible" : "prefetch";
        renderTile({ path, page, scale, tx: t.tx, ty: t.ty, priority }, ctl.signal)
          .then((rgba) => {
            if (!rgba || ctl.signal.aborted) return;
            const canvas = document.createElement("canvas");
            canvas.width = rgba.w;
            canvas.height = rgba.h;
            canvas
              .getContext("2d", { alpha: false })
              ?.putImageData(new ImageData(rgba.pixels, rgba.w, rgba.h), 0, 0);
            tileCache.put(key, canvas);
            attach(canvas, key, r);
            sweepStale();
          })
          .catch(() => {
            if (!ctl.signal.aborted) {
              setFailed(true);
              onError?.(page);
            }
          });
      }
      sweepStale();
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // wantedKey/scale/version capture everything the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, page, scale, wantedKey]);

  // Leaving the visible band: detach (not free) tiles; the cache owns them.
  const hidden = visibleCss === null;
  useEffect(() => {
    const layer = tileLayer.current;
    if (hidden && layer) for (const c of Array.from(layer.children)) c.remove();
  }, [hidden]);

  return (
    <div
      className={`relative ${className ?? ""}`}
      style={{ width: `${cssW}px`, height: `${cssH}px`, background: "#fff", ...style }}
    >
      <img
        src={thumbUrl(path, page, 512, version)}
        alt=""
        draggable={false}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", userSelect: "none" }}
      />
      <div ref={tileLayer} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }} />
      {failed && (
        <div
          className="absolute top-2 left-2 rounded px-2 py-1 text-xs"
          style={{ background: "rgba(239,68,68,.9)", color: "#fff", pointerEvents: "none" }}
        >
          Page failed to render
        </div>
      )}
      {children}
    </div>
  );
}
