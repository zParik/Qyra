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

interface AnnotDivProps {
  annot: PdfAnnotation;
  onClick?: () => void;
}

/**
 * Invisible hover/click target over an annotation. The annotation's visual
 * appearance is baked into the page raster by the renderer (it draws the
 * real /AP appearance streams), so painting a DOM approximation on top would
 * double-render it. This layer only contributes the contents tooltip.
 */
function AnnotDiv({ annot, onClick }: AnnotDivProps) {
  const [hovered, setHovered] = useState(false);
  const [x0, y0, x1, y1] = annot.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

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

  return (
    <div
      style={{
        position: "absolute",
        left: `${x0 * 100}%`,
        top: `${y0 * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
        cursor: onClick ? "pointer" : "default",
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

export function AnnotationLayer({
  pdfPath,
  pageNum,
  isEnabled,
  activeAnnotTool: _activeAnnotTool,
  onAnnotationAdded: _onAnnotationAdded,
}: Props) {
  const { annotations } = useAnnotations(pdfPath, pageNum);

  if (!isEnabled || annotations.length === 0) return null;

  // Text (sticky-note) annotations belong to the comment system: CommentLayer
  // draws them as pins and the renderer hides them from the raster.
  const visible = annotations.filter(
    (a) => a.subtype !== "Text" && a.subtype !== "Note"
  );
  if (visible.length === 0) return null;

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
      {visible.map((annot) => (
        <AnnotDiv key={annot.id} annot={annot} />
      ))}
    </div>
  );
}
