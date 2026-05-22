import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { sanitizeError, type ProgressData } from "../usePanelCommand";
import { StatusBox } from "../components/StatusBox";

type PageSelection = "all" | "current" | "custom";
type CropMode = "margins" | "preset";

interface Preset {
  label: string;
  // normalized [x0, y0, x1, y1]
  rect: [number, number, number, number];
}

const PRESETS: Preset[] = [
  { label: "A4 Portrait",    rect: [0,      0,      1,     1    ] },
  { label: "A4 Landscape",   rect: [0,      0,      1,     1    ] },
  { label: "Letter",         rect: [0,      0,      1,     1    ] },
  { label: "Trim margins",   rect: [0.02,   0.02,   0.98,  0.98 ] },
];

function parseRange(raw: string, total: number): number[] {
  const pages: number[] = [];
  const parts = raw.split(",").map((s) => s.trim());
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = Math.max(1, a ?? 1); i <= Math.min(total, b || total); i++) {
        if (!pages.includes(i)) pages.push(i);
      }
    } else {
      const n = Number(part);
      if (n >= 1 && n <= total && !pages.includes(n)) pages.push(n);
    }
  }
  return pages.sort((a, b) => a - b);
}

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function CropPanel({ file, onApplied }: Props) {
  const totalPages = file.info?.page_count ?? 1;

  const [pageSelection, setPageSelection] = useState<PageSelection>("all");
  const [customRange, setCustomRange]     = useState("1");
  const [cropMode, setCropMode]           = useState<CropMode>("margins");
  const [selectedPreset, setSelectedPreset] = useState(0);

  const [top,    setTop]    = useState(0);
  const [right,  setRight]  = useState(0);
  const [bottom, setBottom] = useState(0);
  const [left,   setLeft]   = useState(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress,     setProgress]     = useState<ProgressData | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [outputPath,   setOutputPath]   = useState<string | null>(null);

  function buildPages(currentPage: number): number[] {
    if (pageSelection === "all") {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    if (pageSelection === "current") {
      return [currentPage];
    }
    return parseRange(customRange, totalPages);
  }

  function buildCropRect(): [number, number, number, number] {
    if (cropMode === "preset") {
      return PRESETS[selectedPreset]!.rect;
    }
    return [
      left   / 100,
      top    / 100,
      1 - right  / 100,
      1 - bottom / 100,
    ];
  }

  async function handleApply() {
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const pages = buildPages(1); // current page not tracked here; pass 1 as default
      const cropRect = buildCropRect();
      const out = await invoke<string>("crop_pages", {
        path: file.path,
        pages,
        cropRect,
      });
      setOutputPath(out);
      onApplied(out);
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
    }
  }

  const inputNumStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 12,
    background: "var(--viewer-bg)",
    border: "1px solid var(--viewer-border)",
    color: "var(--viewer-text)",
    outline: "none",
    textAlign: "center",
    boxSizing: "border-box",
  };

  return (
    <div className="space-y-4">
      {/* Page selection */}
      <div>
        <p className="text-xs font-medium mb-1.5" style={{ color: "var(--viewer-text-sec)" }}>
          Pages to crop
        </p>
        <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--viewer-border)" }}>
          {(["all", "current", "custom"] as PageSelection[]).map((v, i) => (
            <button
              key={v}
              onClick={() => setPageSelection(v)}
              className="flex-1 py-2 text-xs transition-colors"
              style={
                pageSelection === v
                  ? { background: "var(--viewer-accent)", color: "#fff" }
                  : {
                      background: "var(--viewer-bg)",
                      color: "var(--viewer-text-muted)",
                      borderLeft: i > 0 ? "1px solid var(--viewer-border)" : undefined,
                    }
              }
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {pageSelection === "custom" && (
          <input
            style={{
              marginTop: 6,
              width: "100%",
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 12,
              background: "var(--viewer-bg)",
              border: "1px solid var(--viewer-border)",
              color: "var(--viewer-text)",
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
            placeholder="e.g. 1, 3-5, 7"
            value={customRange}
            onChange={(e) => setCustomRange(e.target.value)}
          />
        )}
      </div>

      {/* Crop mode */}
      <div>
        <p className="text-xs font-medium mb-1.5" style={{ color: "var(--viewer-text-sec)" }}>
          Crop mode
        </p>
        <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--viewer-border)" }}>
          {(["margins", "preset"] as CropMode[]).map((v, i) => (
            <button
              key={v}
              onClick={() => setCropMode(v)}
              className="flex-1 py-2 text-xs transition-colors"
              style={
                cropMode === v
                  ? { background: "var(--viewer-accent)", color: "#fff" }
                  : {
                      background: "var(--viewer-bg)",
                      color: "var(--viewer-text-muted)",
                      borderLeft: i > 0 ? "1px solid var(--viewer-border)" : undefined,
                    }
              }
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Margins mode */}
      {cropMode === "margins" && (
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: "var(--viewer-text-sec)" }}>
            Margins to remove (%)
          </p>
          {/* Top row */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
            <div style={{ width: 70 }}>
              <p className="text-xs text-center mb-1" style={{ color: "var(--viewer-text-muted)" }}>Top</p>
              <input
                type="number" min={0} max={49} step={1}
                value={top}
                onChange={(e) => setTop(Math.min(49, Math.max(0, Number(e.target.value))))}
                style={inputNumStyle}
              />
            </div>
          </div>
          {/* Middle row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
            <div style={{ width: 70 }}>
              <p className="text-xs text-center mb-1" style={{ color: "var(--viewer-text-muted)" }}>Left</p>
              <input
                type="number" min={0} max={49} step={1}
                value={left}
                onChange={(e) => setLeft(Math.min(49, Math.max(0, Number(e.target.value))))}
                style={inputNumStyle}
              />
            </div>
            <div
              style={{
                flex: 1,
                height: 50,
                border: "1px dashed var(--viewer-border)",
                borderRadius: 4,
                background: "var(--viewer-bg)",
              }}
            />
            <div style={{ width: 70 }}>
              <p className="text-xs text-center mb-1" style={{ color: "var(--viewer-text-muted)" }}>Right</p>
              <input
                type="number" min={0} max={49} step={1}
                value={right}
                onChange={(e) => setRight(Math.min(49, Math.max(0, Number(e.target.value))))}
                style={inputNumStyle}
              />
            </div>
          </div>
          {/* Bottom row */}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{ width: 70 }}>
              <p className="text-xs text-center mb-1" style={{ color: "var(--viewer-text-muted)" }}>Bottom</p>
              <input
                type="number" min={0} max={49} step={1}
                value={bottom}
                onChange={(e) => setBottom(Math.min(49, Math.max(0, Number(e.target.value))))}
                style={inputNumStyle}
              />
            </div>
          </div>

          {/* Preview description */}
          {(top > 0 || bottom > 0 || left > 0 || right > 0) && (
            <p className="text-xs mt-3" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.5 }}>
              Cropping removes{" "}
              {[
                top    > 0 && `${top}% from top`,
                bottom > 0 && `${bottom}% from bottom`,
                left   > 0 && `${left}% from left`,
                right  > 0 && `${right}% from right`,
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
        </div>
      )}

      {/* Preset mode */}
      {cropMode === "preset" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {PRESETS.map((p, i) => (
            <button
              key={i}
              onClick={() => setSelectedPreset(i)}
              style={{
                padding: "7px 12px",
                fontSize: 12,
                textAlign: "left",
                borderRadius: 7,
                border: "1px solid",
                borderColor: selectedPreset === i ? "var(--accent)" : "var(--viewer-border)",
                background: selectedPreset === i ? "var(--viewer-elevated)" : "var(--viewer-bg)",
                color: selectedPreset === i ? "var(--viewer-text-sec)" : "var(--viewer-text-muted)",
                cursor: "pointer",
                fontWeight: selectedPreset === i ? 600 : 400,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Note */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", fontStyle: "italic" }}>
        Crop is non-destructive and can be undone by resetting margins to 0.
      </p>

      {/* Apply */}
      <button
        className="v-btn-primary w-full"
        disabled={isProcessing}
        onClick={handleApply}
      >
        Apply Crop
      </button>

      {/* Processing */}
      {isProcessing && (
        <div className="mt-2 v-panel-processing">
          {progress && progress.total > 1 ? (
            <ProgressBar current={progress.current} total={progress.total} message={progress.message} />
          ) : (
            <Spinner />
          )}
        </div>
      )}

      {/* Error */}
      {error && !isProcessing && (
        <StatusBox
          status="error"
          message={error}
          onDismiss={() => setError(null)}
          marginTopClass="mt-2"
        />
      )}

      {/* Success */}
      {outputPath && !isProcessing && !error && (
        <StatusBox status="success" title="Crop applied" message="" marginTopClass="mt-2" />
      )}
    </div>
  );
}
