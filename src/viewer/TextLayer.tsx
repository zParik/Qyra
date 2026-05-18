import { useEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

interface CharRect {
  c: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TextLine {
  chars: CharRect[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Highlight {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  isActive: boolean;
}

interface TextLayerProps {
  pdfPath: string;
  pageNum: number;
  /** Kept for API compatibility — not used in positioning since coords are normalised. */
  zoom: number;
  findQuery?: string;
  findActiveMatchOrdinal?: number;
  isDrawingMode?: boolean;
  enabled?: boolean;
}

function computeHighlights(
  chars: CharRect[],
  findQuery: string | undefined,
  activeOrdinal: number,
): Highlight[] {
  if (!findQuery?.trim() || !chars.length) return [];
  const q = findQuery.trim().toLowerCase();
  const fullText = chars.map((c) => c.c).join("");
  const lowerText = fullText.toLowerCase();
  const results: Highlight[] = [];

  let searchIdx = 0;
  let matchCount = 0;
  while (true) {
    const pos = lowerText.indexOf(q, searchIdx);
    if (pos === -1) break;
    const isActive = matchCount === activeOrdinal;
    const matchChars = chars.slice(pos, pos + q.length);

    const buckets = new Map<number, CharRect[]>();
    for (const ch of matchChars) {
      const key = Math.round(((ch.y0 + ch.y1) / 2) * 500);
      const bucket = buckets.get(key) ?? [];
      bucket.push(ch);
      buckets.set(key, bucket);
    }
    for (const group of buckets.values()) {
      results.push({
        x0: group.reduce((m, c) => Math.min(m, c.x0), Infinity),
        y0: group.reduce((m, c) => Math.min(m, c.y0), Infinity),
        x1: group.reduce((m, c) => Math.max(m, c.x1), -Infinity),
        y1: group.reduce((m, c) => Math.max(m, c.y1), -Infinity),
        isActive,
      });
    }

    matchCount++;
    searchIdx = pos + 1;
  }
  return results;
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

const textSemaphore = new SimpleSemaphore(1);

// Shared offscreen canvas for fast text-width measurement
const measureCtx: CanvasRenderingContext2D | null =
  typeof document !== "undefined"
    ? document.createElement("canvas").getContext("2d")
    : null;

interface LineMeta {
  text: string;
  fontPx: number;
  letterSpacingPx: number;
}

/**
 * Transparent overlay placing one DOM span per *line* of text. Each span has
 * an explicit width equal to the PDF line bbox, and `letter-spacing` is
 * computed so the rendered text exactly fills that width. This keeps the
 * span's hit-test rect aligned with the visible glyphs, so dragging a
 * selection inside a line's vertical band always stays "inside" the span and
 * never escapes into a dead zone that the browser would resolve to a
 * neighbouring line (the cause of the wrap-around bug).
 *
 * An `.endOfContent` sentinel at the bottom of the layer expands during an
 * active selection — same trick PDF.js uses — so cursor positions outside
 * the text rects fall back to a deterministic anchor instead of jumping to
 * a random nearby line.
 *
 * Must live inside a `position: relative` element sized to the page image.
 */
export function TextLayer({
  pdfPath,
  pageNum,
  zoom: _zoom,
  findQuery,
  findActiveMatchOrdinal = -1,
  isDrawingMode,
  enabled = true,
}: TextLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const eocRef = useRef<HTMLSpanElement>(null);
  const [lines, setLines] = useState<TextLine[]>([]);
  const [parent, setParent] = useState({ w: 0, h: 0 });

  // PDF.js-style dynamic sentinel positioning. On mousedown we plant the
  // .endOfContent at the cursor's Y; it then covers from that Y down to the
  // bottom of the layer. Cursor positions BELOW the anchor land on the
  // sentinel (browser snaps focus geometrically to nearest text); positions
  // ABOVE the anchor are uncovered and use default browser snap. This makes
  // both upward and downward drags resolve to the natural neighbour line
  // instead of always snapping to the end of the document.
  useEffect(() => {
    const stop = () => {
      const eoc = eocRef.current;
      if (eoc) eoc.style.top = "";
    };
    window.addEventListener("mouseup", stop);
    window.addEventListener("touchend", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("touchend", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);

  const anchorEoc = (clientY: number) => {
    const layer = containerRef.current;
    const eoc = eocRef.current;
    if (!layer || !eoc) return;
    const r = layer.getBoundingClientRect();
    if (r.height <= 0) return;
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    eoc.style.top = `${(y * 100).toFixed(2)}%`;
  };

  const handleMouseDown = (e: React.MouseEvent) => anchorEoc(e.clientY);
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) anchorEoc(e.touches[0].clientY);
  };

  // Track parent (page wrapper) dimensions
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const update = (w: number, h: number) => {
      if (w > 0 && h > 0) setParent({ w, h });
    };
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) update(r.width, r.height);
    });
    obs.observe(el);
    update(el.clientWidth, el.clientHeight);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLines([]);
      return;
    }
    let cancelled = false;
    async function fetchText() {
      await textSemaphore.acquire();
      try {
        if (cancelled) return;
        const data = await invoke<TextLine[]>("get_text_page", {
          path: pdfPath,
          page: pageNum,
        });
        if (!cancelled) setLines(data);
      } catch {
        if (!cancelled) setLines([]);
      } finally {
        textSemaphore.release();
      }
    }
    fetchText();
    return () => {
      cancelled = true;
    };
  }, [pdfPath, pageNum, enabled]);

  // Compute font-size + letter-spacing per line so the rendered text fills
  // the original PDF line bbox without overflow.
  const lineMeta: LineMeta[] = useMemo(() => {
    if (!measureCtx || parent.w === 0 || parent.h === 0) {
      return lines.map(() => ({ text: "", fontPx: 0, letterSpacingPx: 0 }));
    }
    return lines.map((line) => {
      const text = line.chars.map((c) => c.c).join("");
      const fontPx = Math.max(1, (line.y1 - line.y0) * parent.h);
      measureCtx.font = `${fontPx}px sans-serif`;
      const naturalW = measureCtx.measureText(text).width;
      const targetW = (line.x1 - line.x0) * parent.w;
      // letter-spacing is added to every glyph including the last, so
      // (targetW - naturalW) / length spreads the slack uniformly.
      const letterSpacingPx =
        text.length > 0 ? (targetW - naturalW) / text.length : 0;
      return { text, fontPx, letterSpacingPx };
    });
  }, [lines, parent.w, parent.h]);

  const allChars = useMemo(() => lines.flatMap((l) => l.chars), [lines]);
  const highlights = useMemo(
    () => computeHighlights(allChars, findQuery, findActiveMatchOrdinal),
    [allChars, findQuery, findActiveMatchOrdinal],
  );

  return (
    <div
      ref={containerRef}
      className="textLayer"
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: isDrawingMode ? "none" : "auto",
        cursor: isDrawingMode ? "default" : "text",
      }}
    >
      {lines.map((line, li) => {
        const meta = lineMeta[li];
        if (!meta || !meta.text) return null;
        const w = line.x1 - line.x0;
        const h = line.y1 - line.y0;
        if (w <= 0 || h <= 0) return null;
        return (
          <span
            key={li}
            style={{
              position: "absolute",
              left: `${line.x0 * 100}%`,
              top: `${line.y0 * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              fontSize: `${meta.fontPx}px`,
              letterSpacing: `${meta.letterSpacingPx}px`,
              fontFamily: "sans-serif",
              lineHeight: 1,
              color: "transparent",
              whiteSpace: "pre",
              cursor: "text",
              userSelect: "text",
              WebkitUserSelect: "text",
              padding: 0,
              margin: 0,
              overflow: "hidden",
              transformOrigin: "0 0",
            }}
          >
            {meta.text}
          </span>
        );
      })}

      {highlights.map((hl, i) => (
        <div
          key={`hl-${i}`}
          className={hl.isActive ? "find-highlight-active" : "find-highlight"}
          style={{
            position: "absolute",
            left: `${hl.x0 * 100}%`,
            top: `${hl.y0 * 100}%`,
            width: `${(hl.x1 - hl.x0) * 100}%`,
            height: `${(hl.y1 - hl.y0) * 100}%`,
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ))}

      {/* PDF.js-style sentinel. Default position (top: 100%) is off-screen.
          On mousedown we set inline top to the cursor Y so it covers the
          area below the anchor — see handleMouseDown above. */}
      <span ref={eocRef} className="endOfContent" aria-hidden="true" />
    </div>
  );
}
