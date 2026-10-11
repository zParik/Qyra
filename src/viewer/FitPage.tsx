// A single page fitted inside its container (compare panes, presentation),
// rendered crisp by PageView: lossless preview, then exact-pixel tiles.
import React, { useEffect, useRef, useState } from "react";
import { PT_TO_CSS } from "../render/layout";
import { docOpen, type DocInfo } from "../render/renderClient";
import { PageView } from "./PageView";

type Props = { path: string; page: number; style?: React.CSSProperties };

export function FitPage({ path, page, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    docOpen(path).then((i) => { if (!cancelled) setInfo(i); }).catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setBox({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = info?.pages[page - 1];
  const zoom = size && box && box.w > 0 && box.h > 0
    ? Math.min(box.w / (size.w * PT_TO_CSS), box.h / (size.h * PT_TO_CSS))
    : 0;

  return (
    <div
      ref={ref}
      style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", ...style }}
    >
      {info && size && zoom > 0 && (
        <PageView
          path={path}
          version={info.version}
          page={page}
          sizePt={size}
          zoom={zoom}
          dpr={window.devicePixelRatio || 1}
          visibleCss={{ x0: 0, y0: 0, x1: size.w * PT_TO_CSS * zoom, y1: size.h * PT_TO_CSS * zoom }}
        />
      )}
    </div>
  );
}
