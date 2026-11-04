// One page: lossless preview <img> (instant, possibly blurry) under exact-
// device-pixel tile canvases, under the overlay children. Tiles are placed in
// PERCENT of the page box, so tiles from a previous zoom keep lining up
// (stretched) until their replacements land — no blank flash on zoom.
import React, { useEffect, useRef, useState } from "react";
import type { PageSize } from "../render/layout";
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
  const scale = renderScale(zoom, dpr);
  const px = pagePx(sizePt, scale);
  // The box is a whole number of DEVICE pixels, so each 512 px tile spans exactly
  // 512/dpr CSS px and lands 1:1 on screen (no resampling, no seams).
  const cssW = px.w / dpr;
  const cssH = px.h / dpr;
  const tileLayer = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Requests in flight, by tile key: a moving window aborts only tiles it no
  // longer wants instead of restarting everything.
  const inflight = useRef(new Map<string, AbortController>());

  // Prefetch half a viewport above and below (the scroll axis) — bounded, so at
  // high zoom prefetch can't outgrow the tile cache and evict what is on screen.
  const toPx = (r: RectPx, m: number): RectPx => ({
    x0: r.x0 * dpr,
    y0: (r.y0 - m) * dpr,
    x1: r.x1 * dpr,
    y1: (r.y1 + m) * dpr,
  });
  const margin = visibleCss ? (visibleCss.y1 - visibleCss.y0) / 2 : 0;
  const wanted = visibleCss ? tilesInRect(px, toPx(visibleCss, margin)) : [];
  const visibleTiles = new Set(
    visibleCss ? tilesInRect(px, toPx(visibleCss, 0)).map((t) => `${t.tx},${t.ty}`) : [],
  );
  // Quantized to tiles so small scrolls don't re-run the effect.
  const wantedKey = wanted.map((t) => `${t.tx},${t.ty}`).join(";");

  useEffect(() => {
    const layer = tileLayer.current;
    const keysNow = new Set(wanted.map((t) => tileKey(path, version, page, scale, t.tx, t.ty)));
    // Abort requests for tiles that left the window (or belong to an old zoom).
    for (const [key, ctl] of inflight.current) {
      if (!keysNow.has(key)) {
        ctl.abort();
        inflight.current.delete(key);
      }
    }
    if (!layer || wanted.length === 0) return;
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
        const r = tileRectPx(px, t);
        const hit = tileCache.get(key);
        if (hit) {
          attach(hit, key, r);
          continue;
        }
        if (inflight.current.has(key)) continue; // already on its way
        const ctl = new AbortController();
        inflight.current.set(key, ctl);
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
            attach(canvas, key, r);
            tileCache.put(key, canvas);
            sweepStale();
          })
          .catch(() => {
            if (!ctl.signal.aborted) {
              setFailed(true);
              onError?.(page);
            }
          })
          .finally(() => {
            if (inflight.current.get(key) === ctl) inflight.current.delete(key);
          });
      }
      sweepStale();
    }, SETTLE_MS);

    return () => clearTimeout(timer);
    // wantedKey/scale/version capture everything the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, page, scale, wantedKey]);

  // Unmount: abort everything still in flight.
  useEffect(() => {
    const map = inflight.current;
    return () => {
      for (const ctl of map.values()) ctl.abort();
      map.clear();
    };
  }, []);

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
