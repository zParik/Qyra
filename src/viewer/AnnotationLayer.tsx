import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface PdfAnnotation {
  id: string;
  subtype: string;
  rect: [number, number, number, number]; // [x0, y0, x1, y1] normalized
  color: string | null;
  contents: string | null;
  quad_points: number[] | null;
}

interface Props {
  pdfPath: string;
  pageNum: number;
  zoom: number;
  isEnabled: boolean;
  activeAnnotTool: string | null;
  onAnnotationAdded?: () => void;
}

export function useAnnotations(pdfPath: string, pageNum: number) {
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);

  const refresh = useCallback(() => {
    invoke<PdfAnnotation[]>("get_page_annotations", { path: pdfPath, page: pageNum })
      .then(setAnnotations)
      .catch(() => setAnnotations([]));
  }, [pdfPath, pageNum]);

  useEffect(() => {
    let cancelled = false;
    invoke<PdfAnnotation[]>("get_page_annotations", { path: pdfPath, page: pageNum })
      .then((data) => {
        if (!cancelled) setAnnotations(data);
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPath, pageNum]);

  return { annotations, refresh };
}

function hexToRgba(hex: string | null, alpha: number): string {
  if (!hex) return `rgba(255, 235, 59, ${alpha})`;
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(255, 235, 59, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function NoteIcon({ color }: { color: string | null }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={color ?? "#f59e0b"}
      style={{ display: "block" }}
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

interface AnnotDivProps {
  annot: PdfAnnotation;
  onClick?: () => void;
}

function AnnotDiv({ annot, onClick }: AnnotDivProps) {
  const [hovered, setHovered] = useState(false);
  const [x0, y0, x1, y1] = annot.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const posStyle: React.CSSProperties = {
    position: "absolute",
    left: `${x0 * 100}%`,
    top: `${y0 * 100}%`,
    width: `${w * 100}%`,
    height: `${h * 100}%`,
    cursor: onClick ? "pointer" : "default",
  };

  const tooltip =
    hovered && annot.contents ? (
      <div
        style={{
          position: "absolute",
          bottom: "calc(100% + 4px)",
          left: 0,
          background: "var(--viewer-elevated)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 4,
          padding: "4px 8px",
          fontSize: 11,
          color: "var(--viewer-text)",
          whiteSpace: "pre-wrap",
          maxWidth: 220,
          zIndex: 30,
          pointerEvents: "none",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        }}
      >
        {annot.contents}
      </div>
    ) : null;

  const sub = annot.subtype;

  if (sub === "Highlight") {
    if (annot.quad_points && annot.quad_points.length >= 8) {
      // Group quad_points into strips (8 values per quad = one rectangle)
      const strips: React.ReactNode[] = [];
      for (let i = 0; i + 7 < annot.quad_points.length; i += 8) {
        const qx0 = annot.quad_points[i]!;
        const qy0 = annot.quad_points[i + 1]!;
        const qx1 = annot.quad_points[i + 4]!;
        const qy1 = annot.quad_points[i + 5]!;
        const sw = qx1 - qx0;
        const sh = qy1 - qy0;
        if (sw > 0 && sh > 0) {
          strips.push(
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${qx0 * 100}%`,
                top: `${qy0 * 100}%`,
                width: `${sw * 100}%`,
                height: `${sh * 100}%`,
                background: hexToRgba(annot.color, 0.35),
                pointerEvents: "none",
              }}
            />
          );
        }
      }
      return (
        <div
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={onClick}
        >
          {strips}
          {tooltip}
        </div>
      );
    }
    return (
      <div
        style={{
          ...posStyle,
          background: hexToRgba(annot.color, 0.35),
          pointerEvents: "auto",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        {tooltip}
      </div>
    );
  }

  if (sub === "Underline") {
    return (
      <div
        style={{ ...posStyle, pointerEvents: "auto" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 1.5,
            background: hexToRgba(annot.color, 0.85),
          }}
        />
        {tooltip}
      </div>
    );
  }

  if (sub === "StrikeOut") {
    return (
      <div
        style={{ ...posStyle, pointerEvents: "auto" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            height: 1.5,
            background: hexToRgba(annot.color, 0.85),
            transform: "translateY(-50%)",
          }}
        />
        {tooltip}
      </div>
    );
  }

  if (sub === "Square") {
    return (
      <div
        style={{
          ...posStyle,
          border: `2px solid ${hexToRgba(annot.color, 0.85)}`,
          background: hexToRgba(annot.color, 0.08),
          pointerEvents: "auto",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        {tooltip}
      </div>
    );
  }

  if (sub === "Circle") {
    return (
      <div
        style={{
          ...posStyle,
          border: `2px solid ${hexToRgba(annot.color, 0.85)}`,
          background: hexToRgba(annot.color, 0.08),
          borderRadius: "50%",
          pointerEvents: "auto",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        {tooltip}
      </div>
    );
  }

  if (sub === "Note") {
    return (
      <div
        style={{
          ...posStyle,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          pointerEvents: "auto",
          overflow: "visible",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        <NoteIcon color={annot.color} />
        {tooltip}
      </div>
    );
  }

  if (sub === "FreeText") {
    return (
      <div
        style={{
          ...posStyle,
          fontSize: 10,
          color: hexToRgba(annot.color, 1),
          fontFamily: "'Inter', system-ui, sans-serif",
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          padding: 2,
          pointerEvents: "auto",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        {annot.contents}
        {tooltip}
      </div>
    );
  }

  if (sub === "Stamp") {
    const label = annot.contents ?? "STAMP";
    return (
      <div
        style={{
          ...posStyle,
          border: `2px solid ${hexToRgba(annot.color, 0.8)}`,
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: hexToRgba(annot.color, 0.06),
          pointerEvents: "auto",
          overflow: "hidden",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={onClick}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: "clamp(7px, 1.5vw, 12px)",
            fontWeight: 700,
            letterSpacing: "1px",
            color: hexToRgba(annot.color, 0.85),
            textTransform: "uppercase",
            userSelect: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 4px",
          }}
        >
          {label}
        </span>
        {tooltip}
      </div>
    );
  }

  return null;
}

export function AnnotationLayer({
  pdfPath,
  pageNum,
  zoom: _zoom,
  isEnabled,
  activeAnnotTool: _activeAnnotTool,
  onAnnotationAdded: _onAnnotationAdded,
}: Props) {
  const { annotations } = useAnnotations(pdfPath, pageNum);

  if (!isEnabled || annotations.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 12,
        overflow: "visible",
      }}
    >
      {annotations.map((annot) => (
        <AnnotDiv key={annot.id} annot={annot} />
      ))}
    </div>
  );
}
