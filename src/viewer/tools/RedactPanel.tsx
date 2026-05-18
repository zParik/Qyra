import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { sanitizeError, type ProgressData } from "../usePanelCommand";

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
      {/* Instructions */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.5 }}>
        Draw selection boxes on pages to mark text for redaction. Marked regions appear as black
        bars in the output.
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
        <div className="mt-2 v-panel-bad space-y-1.5">
          <p className="text-xs font-semibold" style={{ color: "var(--v-bad-text)" }}>Error</p>
          <p className="text-xs wrap-break-word" style={{ color: "var(--v-bad-text)", opacity: 0.9 }}>
            {error}
          </p>
          <button
            onClick={() => setError(null)}
            className="text-xs underline"
            style={{ color: "var(--v-bad-text)" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Success */}
      {outputPath && !isProcessing && !error && (
        <div className="mt-2 v-panel-ok space-y-1.5">
          <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs font-semibold">Redaction applied</span>
          </div>
          <p className="text-xs" style={{ color: "var(--v-ok-text)", opacity: 0.85 }}>
            {visibleRegions.length} region{visibleRegions.length !== 1 ? "s" : ""} permanently redacted.
          </p>
        </div>
      )}
    </div>
  );
}
