import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import { useNotesStore, Stroke, Point } from "../store/useNotesStore";
import { getStroke } from "perfect-freehand";

export function getSvgPathFromStroke(stroke: number[][]) {
  if (!stroke.length) return "";
  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(x0!, y0!, (x0! + x1!) / 2, (y0! + y1!) / 2);
      return acc;
    },
    ["M", ...stroke[0]!, "Q"]
  );
  d.push("Z");
  return d.join(" ");
}

/** Catmull-Rom spline through pixel-space points → SVG cubic bezier path */
function catmullRomPath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]![0]} ${pts[0]![1]}`;
  if (pts.length === 2)
    return `M ${pts[0]![0]} ${pts[0]![1]} L ${pts[1]![0]} ${pts[1]![1]}`;
  // Duplicate first and last for tension
  const p = [pts[0]!, ...pts, pts[pts.length - 1]!];
  let d = `M ${p[1]![0]} ${p[1]![1]}`;
  for (let i = 1; i < p.length - 2; i++) {
    const cp1x = p[i]![0] + (p[i + 1]![0] - p[i - 1]![0]) / 6;
    const cp1y = p[i]![1] + (p[i + 1]![1] - p[i - 1]![1]) / 6;
    const cp2x = p[i + 1]![0] - (p[i + 2]![0] - p[i]![0]) / 6;
    const cp2y = p[i + 1]![1] - (p[i + 2]![1] - p[i]![1]) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p[i + 1]![0]},${p[i + 1]![1]}`;
  }
  return d;
}

/**
 * Direction-based pressure for calligraphic nib.
 * Returns ~0 when moving parallel to nibAngle, ~1 when perpendicular.
 */
function calPressure(
  prev: [number, number],
  curr: [number, number],
  nibRad: number
): number {
  const dx = curr[0] - prev[0];
  const dy = curr[1] - prev[1];
  if (Math.hypot(dx, dy) < 1e-6) return 0.5;
  const dir = Math.atan2(dy, dx);
  return Math.max(0.06, Math.abs(Math.sin(dir - nibRad)));
}

interface DrawingCanvasProps {
  pageSlotId: string;
  docPath: string;
  isDrawingMode: boolean;
}

function DrawingCanvasInner({
  pageSlotId,
  docPath,
  isDrawingMode,
}: DrawingCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Freehand stroke in progress
  const [currentStroke, setCurrentStroke] = useState<Point[] | null>(null);
  // Live points accumulate in a ref (O(1) push) and flush to state at most once
  // per animation frame. Previously every pointermove did setCurrentStroke([...prev, pt])
  // — an O(n) spread + full re-render per event → O(n²) for one long stroke.
  const livePointsRef = useRef<Point[] | null>(null);
  const liveRafRef = useRef<number | null>(null);

  // Bezier: anchor points placed so far + live cursor preview
  const [bezierPts, setBezierPts] = useState<[number, number][] | null>(null);
  const [bezierCursor, setBezierCursor] = useState<[number, number] | null>(null);
  const lastUpRef = useRef<{ time: number; rx: number; ry: number } | null>(null);

  const addStroke      = useNotesStore((s) => s.addStroke);
  const removeStroke   = useNotesStore((s) => s.removeStroke);
  const replaceStroke  = useNotesStore((s) => s.replaceStroke);
  const docStrokes     = useNotesStore((s) => s.strokes[docPath]);
  const drawColor    = useNotesStore((s) => s.drawColor);
  const drawThickness = useNotesStore((s) => s.drawThickness);
  const drawTool     = useNotesStore((s) => s.drawTool);
  const drawNibAngle = useNotesStore((s) => s.drawNibAngle);
  const eraserSize   = useNotesStore((s) => s.eraserSize);

  // Eraser: cursor position + whether button is held
  const [eraserPos, setEraserPos] = useState<[number, number] | null>(null);
  const isErasingRef = useRef(false);

  const strokes = useMemo(
    () => (docStrokes ?? []).filter((s) => s.pageSlotId === pageSlotId),
    [docStrokes, pageSlotId]
  );

  const [size, setSize] = useState({ w: 768, h: 1024 });
  useEffect(() => {
    if (!containerRef.current) return;
    const ob = new ResizeObserver((entries) => {
      setSize({
        w: entries[0]!.contentRect.width,
        h: entries[0]!.contentRect.height,
      });
    });
    ob.observe(containerRef.current);
    return () => ob.disconnect();
  }, []);

  // Cancel bezier on Escape
  useEffect(() => {
    if (!isDrawingMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && bezierPts !== null) {
        setBezierPts(null);
        setBezierCursor(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDrawingMode, bezierPts]);

  // Flush accumulated live points to state once per frame (coalesces bursts of
  // pointermove events into a single render).
  function scheduleLiveFlush() {
    if (liveRafRef.current != null) return;
    liveRafRef.current = requestAnimationFrame(() => {
      liveRafRef.current = null;
      setCurrentStroke(livePointsRef.current ? livePointsRef.current.slice() : null);
    });
  }

  useEffect(() => () => {
    if (liveRafRef.current != null) cancelAnimationFrame(liveRafRef.current);
  }, []);

  // ── helpers ────────────────────────────────────────────────────────────────

  function relPos(e: React.PointerEvent): [number, number] {
    const rect = containerRef.current!.getBoundingClientRect();
    return [
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    ];
  }

  /**
   * Precision eraser: removes only the points within eraserSize px of (rx, ry).
   * Each stroke that is touched gets split into contiguous surviving segments.
   * Bezier strokes are removed entirely (can't cleanly split Catmull-Rom).
   */
  function eraseAt(rx: number, ry: number) {
    const r = eraserSize;
    const rSq = r * r;

    for (const s of strokes) {
      // Check if any point is hit
      let anyHit = false;
      for (const [px, py] of s.points) {
        const dx = (px - rx) * size.w;
        const dy = (py - ry) * size.h;
        if (dx * dx + dy * dy <= rSq) { anyHit = true; break; }
      }
      if (!anyHit) continue;

      // For bezier strokes, remove entirely (can't split spline cleanly)
      if (s.tool === 'bezier') {
        removeStroke(docPath, s.id);
        continue;
      }

      // Split freehand stroke: collect contiguous segments of surviving points
      const segments: Point[][] = [];
      let current: Point[] = [];

      for (const pt of s.points) {
        const dx = (pt[0] - rx) * size.w;
        const dy = (pt[1] - ry) * size.h;
        if (dx * dx + dy * dy <= rSq) {
          // Point is inside eraser — break the segment
          if (current.length >= 2) segments.push(current);
          current = [];
        } else {
          current.push(pt);
        }
      }
      if (current.length >= 2) segments.push(current);

      if (segments.length === 0) {
        // Every point was erased
        removeStroke(docPath, s.id);
      } else {
        // Replace with surviving fragment strokes
        const fragments: Stroke[] = segments.map((seg) => ({
          id: crypto.randomUUID(),
          pageSlotId: s.pageSlotId,
          tool: s.tool,
          color: s.color,
          baseThickness: s.baseThickness,
          points: seg,
        }));
        replaceStroke(docPath, s.id, fragments);
      }
    }
  }

  function commitBezier(pts: [number, number][]) {
    if (pts.length < 2) { setBezierPts(null); setBezierCursor(null); return; }
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      pageSlotId,
      tool: 'bezier',
      color: drawColor,
      baseThickness: drawThickness,
      points: pts.map(([x, y]) => [x, y, 0]),
    };
    addStroke(docPath, stroke);
    setBezierPts(null);
    setBezierCursor(null);
  }

  // ── pointer handlers ───────────────────────────────────────────────────────

  function handlePointerDown(e: React.PointerEvent) {
    if (!isDrawingMode) return;
    if (e.pointerType === "touch") return;

    if (drawTool === 'eraser') {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      isErasingRef.current = true;
      const [rx, ry] = relPos(e);
      setEraserPos([rx, ry]);
      eraseAt(rx, ry);
      return;
    }

    if (drawTool === 'bezier') {
      // Don't capture — we need click semantics, not drag
      return;
    }

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [rx, ry] = relPos(e);
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5;
    livePointsRef.current = [[rx, ry, pressure]];
    setCurrentStroke([[rx, ry, pressure]]);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDrawingMode) return;
    if (e.pointerType === "touch") return;

    if (drawTool === 'eraser') {
      const [rx, ry] = relPos(e);
      setEraserPos([rx, ry]);
      if (isErasingRef.current) eraseAt(rx, ry);
      return;
    }

    if (drawTool === 'bezier') {
      if (bezierPts !== null) {
        const [rx, ry] = relPos(e);
        setBezierCursor([rx, ry]);
      }
      return;
    }

    const live = livePointsRef.current;
    if (!live) return;
    const [rx, ry] = relPos(e);
    const rawPressure = e.pointerType === 'pen' ? e.pressure : 0.5;

    if (drawTool === 'calligraphy') {
      const prev = live[live.length - 1]!;
      const nibRad = (drawNibAngle * Math.PI) / 180;
      const p = calPressure(
        [prev[0] * size.w, prev[1] * size.h],
        [rx * size.w, ry * size.h],
        nibRad
      );
      live.push([rx, ry, p]);
    } else {
      live.push([rx, ry, rawPressure]);
    }
    scheduleLiveFlush();
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!isDrawingMode) return;
    if (e.pointerType === "touch") return;

    if (drawTool === 'eraser') {
      isErasingRef.current = false;
      return;
    }

    if (drawTool === 'bezier') {
      const [rx, ry] = relPos(e);
      const now = Date.now();
      const last = lastUpRef.current;

      // Double-click detection: same position within 350ms
      const isDouble =
        last !== null &&
        now - last.time < 350 &&
        Math.hypot((rx - last.rx) * size.w, (ry - last.ry) * size.h) < 12;

      if (isDouble) {
        // Finalize — drop the duplicate point the first click already added
        commitBezier(bezierPts ?? []);
        lastUpRef.current = null;
        return;
      }

      lastUpRef.current = { time: now, rx, ry };
      setBezierPts((prev) => [...(prev ?? []), [rx, ry]]);
      return;
    }

    // Freehand tools
    if (liveRafRef.current != null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    const pts = livePointsRef.current;
    livePointsRef.current = null;
    if (!pts || pts.length < 2) {
      setCurrentStroke(null);
      return;
    }
    const newStroke: Stroke = {
      id: crypto.randomUUID(),
      pageSlotId,
      tool: drawTool,
      color: drawColor,
      baseThickness:
        drawTool === 'highlighter' ? drawThickness * 3 : drawThickness,
      points: pts,
    };
    addStroke(docPath, newStroke);
    setCurrentStroke(null);
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  function renderFreehandStroke(
    pts: Point[],
    thickness: number,
    color: string,
    tool: Stroke['tool']
  ) {
    const scaledPts = pts.map(
      (p) => [p[0] * size.w, p[1] * size.h, p[2]] as [number, number, number]
    );
    const isHighlighter = tool === 'highlighter';
    const isCalligraphy = tool === 'calligraphy';
    const outlineData = getStroke(scaledPts, {
      size: thickness,
      thinning: isCalligraphy ? 0.85 : isHighlighter ? 0 : 0.5,
      smoothing: isCalligraphy ? 0.3 : 0.5,
      streamline: isHighlighter ? 0.3 : 0.5,
      simulatePressure: false,
    });
    return (
      <path
        d={getSvgPathFromStroke(outlineData)}
        fill={color}
        fillOpacity={isHighlighter ? 0.35 : 1}
      />
    );
  }

  function renderBezierStroke(pts: Point[], thickness: number, color: string) {
    const pxPts: [number, number][] = pts.map((p) => [
      p[0] * size.w,
      p[1] * size.h,
    ]);
    return (
      <path
        d={catmullRomPath(pxPts)}
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    );
  }

  function renderStroke(s: Stroke) {
    if (s.tool === 'bezier') {
      return renderBezierStroke(s.points, s.baseThickness, s.color);
    }
    return renderFreehandStroke(s.points, s.baseThickness, s.color, s.tool);
  }

  // In-progress bezier preview
  const bezierPreviewPts: [number, number][] = bezierPts
    ? bezierCursor
      ? [...bezierPts, bezierCursor]
      : bezierPts
    : [];

  // Committed strokes only re-render when they (or geometry) change — not on every
  // live-stroke frame, so drawing on a heavily-annotated page stays cheap.
  const committedEls = useMemo(
    () => strokes.map((s) => <g key={s.id}>{renderStroke(s)}</g>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strokes, size.w, size.h]
  );

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-10 ${isDrawingMode ? 'touch-none' : 'pointer-events-none'}`}
      style={{
        overflow: 'hidden',
        cursor: !isDrawingMode ? 'default'
          : drawTool === 'eraser' ? 'none'
          : 'crosshair',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => setEraserPos(null)}
    >
      <svg className="w-full h-full absolute inset-0 pointer-events-none">
        {/* Committed strokes */}
        {committedEls}

        {/* Freehand in-progress */}
        {currentStroke && currentStroke.length > 1 && (
          <g>
            {renderFreehandStroke(
              currentStroke,
              drawTool === 'highlighter' ? drawThickness * 3 : drawThickness,
              drawColor,
              drawTool
            )}
          </g>
        )}

        {/* Bezier in-progress: path preview */}
        {bezierPreviewPts.length >= 2 && (
          <path
            d={catmullRomPath(
              bezierPreviewPts.map(([x, y]) => [x * size.w, y * size.h])
            )}
            stroke={drawColor}
            strokeWidth={drawThickness}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="6 4"
            strokeOpacity={0.7}
            fill="none"
          />
        )}

        {/* Eraser cursor */}
        {isDrawingMode && drawTool === 'eraser' && eraserPos && (
          <g>
            <circle
              cx={eraserPos[0] * size.w}
              cy={eraserPos[1] * size.h}
              r={eraserSize}
              fill={isErasingRef.current ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)"}
              stroke="rgba(80,80,80,0.7)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {/* centre dot */}
            <circle
              cx={eraserPos[0] * size.w}
              cy={eraserPos[1] * size.h}
              r={1.5}
              fill="rgba(80,80,80,0.6)"
            />
          </g>
        )}

        {/* Bezier anchor points */}
        {bezierPts &&
          bezierPts.map(([x, y], i) => (
            <circle
              key={i}
              cx={x * size.w}
              cy={y * size.h}
              r={4}
              fill={drawColor}
              fillOpacity={0.9}
              stroke="white"
              strokeWidth={1.5}
            />
          ))}
      </svg>

      {/* Bezier mode hint */}
      {isDrawingMode && drawTool === 'bezier' && bezierPts && bezierPts.length > 0 && (
        <div
          className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs px-2 py-1 rounded pointer-events-none"
          style={{
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            whiteSpace: "nowrap",
          }}
        >
          {bezierPts.length} pt{bezierPts.length !== 1 ? 's' : ''} — double-click to finish · Esc to cancel
        </div>
      )}
    </div>
  );
}

// All props primitive (pageSlotId/docPath/isDrawingMode). Memoized so a page's
// canvas is not re-rendered on every Viewer re-render (scroll/thumbnail/zoom).
// Zoom is no longer a prop — the page box is GPU-scaled by a CSS transform, so the
// canvas renders once at base size and the browser scales it. Internal drawing
// state still re-renders it when the user actually draws.
export const DrawingCanvas = memo(DrawingCanvasInner);
