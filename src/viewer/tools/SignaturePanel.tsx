import { useEffect, useRef, useState } from "react";

const SIG_STORAGE_KEY = "qyra_signatures";
const MAX_SAVED = 3;

function loadSavedSigs(): string[] {
  try {
    const raw = localStorage.getItem(SIG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSig(dataUrl: string) {
  const existing = loadSavedSigs().filter((s) => s !== dataUrl);
  const next = [dataUrl, ...existing].slice(0, MAX_SAVED);
  localStorage.setItem(SIG_STORAGE_KEY, JSON.stringify(next));
}

type Tab = "draw" | "type" | "upload";
type FontStyle = "script" | "print";
type FontSize = "small" | "medium" | "large";

const FONT_MAP: Record<FontStyle, string> = {
  script: "Dancing Script, cursive",
  print: "Georgia, serif",
};

const FONT_SIZE_MAP: Record<FontSize, number> = {
  small: 28,
  medium: 40,
  large: 56,
};

interface SignaturePanelProps {
  onSignatureCreated: (dataUrl: string) => void;
  onClose: () => void;
}

export function SignaturePanel({ onSignatureCreated, onClose }: SignaturePanelProps) {
  const [tab, setTab] = useState<Tab>("draw");
  const [savedSigs, setSavedSigs] = useState<string[]>(() => loadSavedSigs());

  // Draw tab state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const [hasDrawn, setHasDrawn] = useState(false);

  // Type tab state
  const [typedText, setTypedText] = useState("");
  const [fontStyle, setFontStyle] = useState<FontStyle>("script");
  const [fontSize, setFontSize] = useState<FontSize>("medium");

  // Upload tab state
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Canvas helpers ────────────────────────────────────────────────────────

  function getCanvasPos(e: MouseEvent | { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function startDraw(e: React.MouseEvent<HTMLCanvasElement>) {
    isDrawingRef.current = true;
    lastPosRef.current = getCanvasPos(e.nativeEvent);
    setHasDrawn(true);
  }

  function draw(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d")!;
    const pos = getCanvasPos(e.nativeEvent);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current!.x, lastPosRef.current!.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    lastPosRef.current = pos;
  }

  function endDraw() {
    isDrawingRef.current = false;
    lastPosRef.current = null;
  }

  function startDrawTouch(e: React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    isDrawingRef.current = true;
    lastPosRef.current = getCanvasPos(e.touches[0]);
    setHasDrawn(true);
  }

  function drawTouch(e: React.TouchEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (!isDrawingRef.current || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d")!;
    const pos = getCanvasPos(e.touches[0]);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current!.x, lastPosRef.current!.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    lastPosRef.current = pos;
  }

  function clearCanvas() {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d")!;
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setHasDrawn(false);
  }

  // Initialise canvas background to white
  useEffect(() => {
    if (tab === "draw" && canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, [tab]);

  // ── Confirm helpers ───────────────────────────────────────────────────────

  function getDrawDataUrl(): string | null {
    if (!canvasRef.current || !hasDrawn) return null;
    return canvasRef.current.toDataURL("image/png");
  }

  function getTypeDataUrl(): string | null {
    if (!typedText.trim()) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 120;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const px = FONT_SIZE_MAP[fontSize];
    ctx.font = `${px}px ${FONT_MAP[fontStyle]}`;
    ctx.fillStyle = "#111";
    ctx.textBaseline = "middle";
    ctx.fillText(typedText, 12, canvas.height / 2);
    return canvas.toDataURL("image/png");
  }

  function handleSaveAndUse() {
    let dataUrl: string | null = null;
    if (tab === "draw") dataUrl = getDrawDataUrl();
    else if (tab === "type") dataUrl = getTypeDataUrl();
    else if (tab === "upload") dataUrl = uploadPreview;

    if (!dataUrl) return;
    saveSig(dataUrl);
    setSavedSigs(loadSavedSigs());
    onSignatureCreated(dataUrl);
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  const canConfirm =
    (tab === "draw" && hasDrawn) ||
    (tab === "type" && !!typedText.trim()) ||
    (tab === "upload" && !!uploadPreview);

  // ── Tab content ───────────────────────────────────────────────────────────

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "6px 4px",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    color: active ? "var(--accent)" : "var(--viewer-text-muted)",
    background: "none",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    cursor: "pointer",
    transition: "color 0.15s",
  });

  const inputStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    background: "var(--viewer-bg)",
    border: "1px solid var(--viewer-border)",
    color: "var(--viewer-text)",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 100,
        background: "var(--viewer-elevated)",
        border: "1px solid var(--viewer-border)",
        borderRadius: 12,
        padding: 20,
        width: 380,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--viewer-text-sec)" }}>
          Create Signature
        </span>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--viewer-text-muted)", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--viewer-border)", marginBottom: 14 }}>
        {(["draw", "type", "upload"] as Tab[]).map((t) => (
          <button key={t} style={tabBtnStyle(tab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Draw tab */}
      {tab === "draw" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <canvas
            ref={canvasRef}
            width={340}
            height={130}
            style={{
              width: "100%",
              height: 130,
              border: "1px solid var(--viewer-border)",
              borderRadius: 6,
              background: "#fff",
              cursor: "crosshair",
              touchAction: "none",
            }}
            onMouseDown={startDraw}
            onMouseMove={draw}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            onTouchStart={startDrawTouch}
            onTouchMove={drawTouch}
            onTouchEnd={endDraw}
          />
          <button
            onClick={clearCanvas}
            style={{
              alignSelf: "flex-end",
              background: "none",
              border: "1px solid var(--viewer-border)",
              borderRadius: 6,
              padding: "3px 10px",
              fontSize: 11,
              color: "var(--viewer-text-muted)",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Type tab */}
      {tab === "type" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            style={inputStyle}
            placeholder="Type your name…"
            value={typedText}
            onChange={(e) => setTypedText(e.target.value)}
            maxLength={60}
          />

          {/* Font style toggle */}
          <div style={{ display: "flex", gap: 6 }}>
            {(["script", "print"] as FontStyle[]).map((fs) => (
              <button
                key={fs}
                onClick={() => setFontStyle(fs)}
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid var(--viewer-border)",
                  background: fontStyle === fs ? "var(--accent)" : "var(--viewer-bg)",
                  color: fontStyle === fs ? "#fff" : "var(--viewer-text-muted)",
                  cursor: "pointer",
                  fontFamily: FONT_MAP[fs],
                }}
              >
                {fs === "script" ? "Script" : "Print"}
              </button>
            ))}
          </div>

          {/* Font size */}
          <div style={{ display: "flex", gap: 6 }}>
            {(["small", "medium", "large"] as FontSize[]).map((s) => (
              <button
                key={s}
                onClick={() => setFontSize(s)}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid var(--viewer-border)",
                  background: fontSize === s ? "var(--viewer-elevated)" : "var(--viewer-bg)",
                  color: fontSize === s ? "var(--viewer-text-sec)" : "var(--viewer-text-muted)",
                  cursor: "pointer",
                  fontWeight: fontSize === s ? 600 : 400,
                  outline: fontSize === s ? "1px solid var(--accent)" : "none",
                }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Preview */}
          {typedText && (
            <div
              style={{
                height: 80,
                border: "1px solid var(--viewer-border)",
                borderRadius: 6,
                background: "#fff",
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  fontFamily: FONT_MAP[fontStyle],
                  fontSize: FONT_SIZE_MAP[fontSize],
                  color: "#111",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                }}
              >
                {typedText}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Upload tab */}
      {tab === "upload" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: 90,
              border: "1px dashed var(--viewer-border)",
              borderRadius: 8,
              cursor: "pointer",
              color: "var(--viewer-text-muted)",
              fontSize: 12,
            }}
          >
            <svg width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 10l-4-4m0 0L8 10m4-4v12" />
            </svg>
            <span>Click to upload image</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handleUpload}
            />
          </label>
          {uploadPreview && (
            <div
              style={{
                border: "1px solid var(--viewer-border)",
                borderRadius: 6,
                overflow: "hidden",
                background: "#fff",
                textAlign: "center",
              }}
            >
              <img
                src={uploadPreview}
                alt="Signature preview"
                style={{ maxHeight: 100, maxWidth: "100%", objectFit: "contain" }}
              />
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={onClose}
          style={{
            flex: 1,
            padding: "7px 12px",
            fontSize: 12,
            borderRadius: 7,
            border: "1px solid var(--viewer-border)",
            background: "var(--viewer-bg)",
            color: "var(--viewer-text-muted)",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSaveAndUse}
          disabled={!canConfirm}
          style={{
            flex: 2,
            padding: "7px 12px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 7,
            border: "none",
            background: canConfirm ? "var(--accent)" : "var(--viewer-border)",
            color: canConfirm ? "#fff" : "var(--viewer-text-muted)",
            cursor: canConfirm ? "pointer" : "not-allowed",
            transition: "background 0.15s",
          }}
        >
          Save &amp; Use
        </button>
      </div>

      {/* Saved signatures */}
      {savedSigs.length > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--viewer-border)", paddingTop: 12 }}>
          <p style={{ fontSize: 11, color: "var(--viewer-text-muted)", marginBottom: 6 }}>
            Recent signatures
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {savedSigs.map((sig, i) => (
              <button
                key={i}
                onClick={() => onSignatureCreated(sig)}
                title="Use this signature"
                style={{
                  padding: 3,
                  border: "1px solid var(--viewer-border)",
                  borderRadius: 6,
                  background: "#fff",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <img
                  src={sig}
                  alt={`Saved signature ${i + 1}`}
                  style={{ height: 36, width: 100, objectFit: "contain", display: "block" }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
