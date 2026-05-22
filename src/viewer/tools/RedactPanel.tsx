import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { sanitizeError, type ProgressData } from "../usePanelCommand";
import { StatusBox } from "../components/StatusBox";

export interface RedactRegion {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RedactPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
  markedRegions: RedactRegion[];
  onClearRegions: () => void;
  currentPage: number;
  mode: "region" | "text";
  onModeChange: (m: "region" | "text") => void;
}

function fmt(n: number) {
  return n.toFixed(1);
}

export function RedactPanel({
  file,
  onApplied,
  markedRegions,
  onClearRegions,
  currentPage: _currentPage,
  mode,
  onModeChange,
}: RedactPanelProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  // Allow parent to remove one region — we surface a remove callback via a
  // local copy that the parent should reconcile. Since the parent owns the
  // list, we expose `onRemoveRegion` as a no-op default; parent should pass it
  // if needed. For the common case we keep a local "removed" set.
  const [removedIndexes, setRemovedIndexes] = useState<Set<number>>(new Set());

  const visibleRegions = markedRegions.filter((_, i) => !removedIndexes.has(i));

  function removeRegion(originalIndex: number) {
    setRemovedIndexes((prev) => new Set([...prev, originalIndex]));
  }

  function handleClearAll() {
    setRemovedIndexes(new Set());
    onClearRegions();
  }

  async function handleApply() {
    if (visibleRegions.length === 0) return;
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const regions = visibleRegions.map((r) => ({
        page: r.page,
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
      }));
      const out = await invoke<string>("redact_pdf", { path: file.path, regions });
      setOutputPath(out);
      // Regions are now baked into the output file as destroyed pixels. Clear
      // the overlay state so the new file isn't covered by phantom rects that
      // no longer reference real content, and so the panel doesn't suggest
      // there's still work to apply. The viewer swaps to `out` via onApplied,
      // which triggers TextLayer / render refetch from the new path — the
      // destroyed glyphs are gone from text extraction, so selection won't
      // pick them up either.
      setRemovedIndexes(new Set());
      onClearRegions();
      onApplied(out);
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 0,
          border: "1px solid var(--viewer-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {(["region", "text"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className="text-xs"
              style={{
                padding: "8px 6px",
                border: "none",
                cursor: "pointer",
                background: active ? "var(--accent)" : "transparent",
                color: active ? "#fff" : "var(--viewer-text-sec)",
                fontWeight: active ? 600 : 500,
                transition: "background 120ms",
              }}
            >
              {m === "region" ? "Region drag" : "Text select"}
            </button>
          );
        })}
      </div>

      {/* Instructions */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.5 }}>
        {mode === "region" ? (
          <>
            Drag selection boxes on a page to mark regions. On export, every glyph, image, and
            vector inside each region is permanently destroyed and replaced with a solid black
            rectangle — the original content cannot be recovered from the output file.
          </>
        ) : (
          <>
            Highlight text on a page exactly like normal text selection. On mouse-up, every line
            of the selection is captured as a tight redaction region. On export the underlying
            text is permanently destroyed (not just covered).
          </>
        )}
      </p>

      {/* Region list */}
      {visibleRegions.length === 0 ? (
        <div
          style={{
            padding: "12px 10px",
            border: "1px dashed var(--viewer-border)",
            borderRadius: 8,
            textAlign: "center",
          }}
        >
          <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
            No regions marked yet. Use the selection tool on the page.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p className="text-xs font-medium" style={{ color: "var(--viewer-text-sec)" }}>
              Marked regions ({visibleRegions.length})
            </p>
            <button
              onClick={handleClearAll}
              className="text-xs"
              style={{ color: "var(--viewer-text-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
            >
              Clear All
            </button>
          </div>

          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              border: "1px solid var(--viewer-border)",
              borderRadius: 8,
              padding: "4px 0",
            }}
          >
            {markedRegions.map((r, i) => {
              if (removedIndexes.has(i)) return null;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "5px 10px",
                    borderBottom: i < markedRegions.length - 1 ? "1px solid var(--viewer-border)" : "none",
                  }}
                >
                  <div>
                    <span className="text-xs font-medium" style={{ color: "var(--viewer-text-sec)" }}>
                      Page {r.page}
                    </span>
                    <span className="text-xs" style={{ color: "var(--viewer-text-muted)", marginLeft: 6 }}>
                      ({fmt(r.x0)}, {fmt(r.y0)}) → ({fmt(r.x1)}, {fmt(r.y1)})
                    </span>
                  </div>
                  <button
                    onClick={() => removeRegion(i)}
                    title="Remove region"
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--viewer-text-muted)",
                      fontSize: 15,
                      lineHeight: 1,
                      padding: "0 2px",
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Apply button */}
      <button
        className="v-btn-primary w-full"
        disabled={isProcessing || visibleRegions.length === 0}
        onClick={handleApply}
      >
        Apply Redaction
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
        <StatusBox
          status="success"
          title="Redaction applied"
          message={`${visibleRegions.length} region${visibleRegions.length !== 1 ? "s" : ""} permanently redacted.`}
          marginTopClass="mt-2"
        />
      )}
    </div>
  );
}
