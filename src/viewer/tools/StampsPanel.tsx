import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UI, MONO } from "../../lib/tokens";

interface Props {
  filePath: string;
  currentPage: number;
  onApplied: (newPath: string) => void;
}

const STAMPS = [
  { id: "Approved",    label: "Approved",     color: "#16a34a" },
  { id: "Confidential", label: "Confidential", color: "#dc2626" },
  { id: "Draft",       label: "Draft",        color: "#2563eb" },
  { id: "Rejected",    label: "Rejected",     color: "#dc2626" },
  { id: "Final",       label: "Final",        color: "#16a34a" },
  { id: "Expired",     label: "Expired",      color: "#9333ea" },
  { id: "ForReview",   label: "For Review",   color: "#d97706" },
  { id: "NotApproved", label: "Not Approved", color: "#b91c1c" },
];

type Position = "top-right" | "center" | "top-left";

export function StampsPanel({ filePath, currentPage, onApplied }: Props) {
  const [status, setStatus] = useState<"idle" | "applying" | "done" | "error">("idle");
  const [selectedStamp, setSelectedStamp] = useState("Approved");
  const [position, setPosition] = useState<Position>("top-right");
  const [pageInput, setPageInput] = useState(currentPage);

  async function applyStamp() {
    const stamp = STAMPS.find((s) => s.id === selectedStamp);
    if (!stamp) return;

    const sw = 0.28;
    const sh = 0.10;
    let x0: number, y0: number;
    if (position === "top-right")  { x0 = 0.68; y0 = 0.04; }
    else if (position === "top-left") { x0 = 0.04; y0 = 0.04; }
    else                           { x0 = 0.36; y0 = 0.45; }

    setStatus("applying");
    try {
      const newPath = await invoke<string>("add_pdf_annotation", {
        path: filePath,
        annotation: {
          subtype: "Stamp",
          page: pageInput,
          rect: [x0, y0, x0 + sw, y0 + sh],
          color: stamp.color,
          contents: stamp.label,
          stampName: stamp.id,
        },
      });
      setStatus("done");
      onApplied(newPath);
      setTimeout(() => setStatus("idle"), 1800);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2000);
    }
  }

  return (
    <div style={{ padding: "12px 12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Page */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: UI, fontSize: 11, color: "var(--viewer-text-sec)" }}>Page</span>
        <input
          type="number"
          min={1}
          value={pageInput}
          onChange={(e) => setPageInput(Math.max(1, Number(e.target.value)))}
          style={{
            width: 52, padding: "3px 6px", borderRadius: 5,
            border: "1px solid var(--viewer-border)",
            background: "var(--viewer-bg)", color: "var(--viewer-text)",
            fontFamily: MONO, fontSize: 11, outline: "none",
          }}
        />
      </div>

      {/* Stamp picker */}
      <div>
        <p style={{ fontFamily: UI, fontSize: 11, fontWeight: 500, color: "var(--viewer-text-sec)", margin: "0 0 6px" }}>
          Stamp type
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
          {STAMPS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedStamp(s.id)}
              style={{
                padding: "5px 6px",
                borderRadius: 5,
                border: `1.5px solid ${selectedStamp === s.id ? s.color : "var(--viewer-border)"}`,
                background: selectedStamp === s.id ? `${s.color}18` : "var(--viewer-bg)",
                color: selectedStamp === s.id ? s.color : "var(--viewer-text-muted)",
                fontFamily: MONO,
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.4px",
                cursor: "pointer",
                textAlign: "center",
                transition: "all 100ms",
              }}
            >
              {s.label.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Position picker */}
      <div>
        <p style={{ fontFamily: UI, fontSize: 11, fontWeight: 500, color: "var(--viewer-text-sec)", margin: "0 0 6px" }}>
          Position
        </p>
        <div style={{ display: "flex", gap: 4 }}>
          {(["top-left", "top-right", "center"] as Position[]).map((p) => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              style={{
                flex: 1, padding: "5px 2px", borderRadius: 5,
                border: `1px solid ${position === p ? "var(--accent)" : "var(--viewer-border)"}`,
                background: position === p ? "var(--accent-soft)" : "var(--viewer-bg)",
                color: position === p ? "var(--accent)" : "var(--viewer-text-muted)",
                fontFamily: UI, fontSize: 10, cursor: "pointer",
                transition: "all 100ms",
              }}
            >
              {p === "top-left" ? "Top Left" : p === "top-right" ? "Top Right" : "Center"}
            </button>
          ))}
        </div>
      </div>

      {/* Apply */}
      <button
        onClick={applyStamp}
        disabled={status === "applying"}
        style={{
          padding: "7px 0", borderRadius: 6, border: "none",
          background: status === "done" ? "#16a34a" : status === "error" ? "#dc2626" : "var(--accent)",
          color: "#fff", fontFamily: UI, fontSize: 12, fontWeight: 600,
          cursor: status === "applying" ? "not-allowed" : "pointer",
          transition: "background 200ms",
        }}
      >
        {status === "applying" ? "Placing…" : status === "done" ? "Stamp placed ✓" : status === "error" ? "Error — retry" : "Place Stamp"}
      </button>
    </div>
  );
}
