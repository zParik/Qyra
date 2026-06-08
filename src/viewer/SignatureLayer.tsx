import { useCallback, useEffect, useRef, useState } from "react";

export interface Signature {
  id: string;
  dataUrl: string;
  pageNum: number;
  x: number;    // center x [0,1]
  y: number;    // center y [0,1]
  width: number;  // [0,1]
  height: number; // [0,1]
}

interface Props {
  pdfPath: string;
  pageNum: number;
  isEnabled: boolean;
  pendingSignature: string | null;
  onSignaturePlaced: (sig: Signature) => void;
  onSignatureRemoved: (id: string) => void;
  signatures: Signature[];
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  origWidth: number;
  origHeight: number;
}

export function SignatureLayer({
  pdfPath: _pdfPath,
  pageNum,
  isEnabled,
  pendingSignature,
  onSignaturePlaced,
  onSignatureRemoved,
  signatures,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [localSigs, setLocalSigs] = useState<Signature[]>([]);

  // Sync local copies so we can update widths during resize without mutating parent
  useEffect(() => {
    setLocalSigs(signatures.filter((s) => s.pageNum === pageNum));
  }, [signatures, pageNum]);

  // Natural aspect ratio of the pending signature image
  const pendingAspectRef = useRef<number>(1);
  useEffect(() => {
    if (!pendingSignature) return;
    const img = new Image();
    img.onload = () => {
      pendingAspectRef.current =
        img.naturalHeight > 0 ? img.naturalHeight / img.naturalWidth : 1;
    };
    img.src = pendingSignature;
  }, [pendingSignature]);

  const getNormPos = useCallback((e: React.MouseEvent): { x: number; y: number } | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x, y };
  }, []);

  function handleMouseMove(e: React.MouseEvent) {
    if (dragState) {
      handleResizeDrag(e);
      return;
    }
    if (!isEnabled || !pendingSignature) {
      setGhostPos(null);
      return;
    }
    const pos = getNormPos(e);
    if (pos) setGhostPos(pos);
  }

  function handleMouseLeave() {
    if (!dragState) setGhostPos(null);
  }

  function handleClick(e: React.MouseEvent) {
    if (!isEnabled || !pendingSignature) return;
    const pos = getNormPos(e);
    if (!pos) return;

    const defaultWidth = 0.4;
    const defaultHeight = defaultWidth * pendingAspectRef.current;

    const sig: Signature = {
      id: crypto.randomUUID(),
      dataUrl: pendingSignature,
      pageNum,
      x: pos.x,
      y: pos.y,
      width: defaultWidth,
      height: defaultHeight,
    };
    onSignaturePlaced(sig);
  }

  // Resize handle drag
  function handleResizeStart(e: React.MouseEvent, sig: Signature) {
    e.stopPropagation();
    e.preventDefault();
    setDragState({
      id: sig.id,
      startX: e.clientX,
      startY: e.clientY,
      origWidth: sig.width,
      origHeight: sig.height,
    });
  }

  function handleResizeDrag(e: React.MouseEvent) {
    if (!dragState) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = (e.clientX - dragState.startX) / rect.width;
    const dy = (e.clientY - dragState.startY) / rect.height;
    // Use the larger delta to keep aspect ratio (shift-resize style)
    const delta = Math.max(dx, dy);
    const newWidth = Math.max(0.05, dragState.origWidth + delta);
    const aspect =
      dragState.origHeight > 0 ? dragState.origHeight / dragState.origWidth : 1;
    const newHeight = newWidth * aspect;

    setLocalSigs((prev) =>
      prev.map((s) =>
        s.id === dragState.id ? { ...s, width: newWidth, height: newHeight } : s
      )
    );
  }

  function handleResizeEnd(_e: MouseEvent | React.MouseEvent) {
    if (!dragState) return;
    const updated = localSigs.find((s) => s.id === dragState.id);
    if (updated) {
      // Notify parent of final size via onSignaturePlaced (re-place with same id is fine)
      onSignaturePlaced({ ...updated });
    }
    setDragState(null);
  }

  useEffect(() => {
    if (!dragState) return;
    const onUp = (e: MouseEvent) => handleResizeEnd(e);
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState, localSigs]);

  const showGhost = isEnabled && !!pendingSignature && !!ghostPos;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        cursor:
          isEnabled && pendingSignature
            ? "crosshair"
            : dragState
            ? "nwse-resize"
            : "default",
        pointerEvents: isEnabled || localSigs.length > 0 ? "auto" : "none",
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      {/* Placed signatures */}
      {localSigs.map((sig) => {
        const left = (sig.x - sig.width / 2) * 100;
        const top = (sig.y - sig.height / 2) * 100;
        const w = sig.width * 100;
        const h = sig.height * 100;
        const isHovered = hoveredId === sig.id;
        return (
          <div
            key={sig.id}
            style={{
              position: "absolute",
              left: `${left}%`,
              top: `${top}%`,
              width: `${w}%`,
              height: `${h}%`,
            }}
            onMouseEnter={() => setHoveredId(sig.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={sig.dataUrl}
              alt="Signature"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />

            {/* Delete button */}
            {isHovered && (
              <button
                type="button"
                aria-label="Remove signature"
                onClick={(e) => {
                  e.stopPropagation();
                  onSignatureRemoved(sig.id);
                }}
                style={{
                  position: "absolute",
                  top: -10,
                  right: -10,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#ef4444",
                  border: "none",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                  zIndex: 2,
                }}
              >
                ×
              </button>
            )}

            {/* Resize handle */}
            {isHovered && (
              <div
                onMouseDown={(e) => handleResizeStart(e, sig)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  bottom: -5,
                  right: -5,
                  width: 12,
                  height: 12,
                  background: "var(--accent, #6366f1)",
                  border: "1.5px solid #fff",
                  borderRadius: 2,
                  cursor: "nwse-resize",
                  zIndex: 2,
                }}
              />
            )}
          </div>
        );
      })}

      {/* Ghost preview following cursor */}
      {showGhost && ghostPos && (
        <img
          src={pendingSignature!}
          alt="Signature preview"
          draggable={false}
          style={{
            position: "absolute",
            left: `${(ghostPos.x - 0.2) * 100}%`,
            top: `${(ghostPos.y - 0.1) * 100}%`,
            width: "40%",
            opacity: 0.55,
            pointerEvents: "none",
            userSelect: "none",
            objectFit: "contain",
          }}
        />
      )}
    </div>
  );
}
