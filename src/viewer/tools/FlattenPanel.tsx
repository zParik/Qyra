import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { Spinner } from "../../components/ProgressBar";
import { sanitizeError, type ProgressData } from "../usePanelCommand";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

const CHECKLIST = [
  "Form fields → baked in",
  "PDF annotations → baked in",
  "AcroForm dictionary → removed",
];

export function FlattenPanel({ file, onApplied }: Props) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress,     setProgress]     = useState<ProgressData | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [outputPath,   setOutputPath]   = useState<string | null>(null);

  async function handleFlatten() {
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const out = await invoke<string>("flatten_pdf", { path: file.path });
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
      {/* Description */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Merges all form fields and annotations permanently into the page content. Required before
        printing or archiving.
      </p>

      {/* Checklist */}
      <div
        style={{
          border: "1px solid var(--viewer-border)",
          borderRadius: 8,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {CHECKLIST.map((item) => (
          <div key={item} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ color: "var(--v-ok-text)", flexShrink: 0 }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
              {item}
            </span>
          </div>
        ))}
      </div>

      {/* Warning */}
      <div
        style={{
          background: "var(--v-bad-bg)",
          border: "1px solid var(--v-bad-border)",
          borderRadius: 7,
          padding: "8px 10px",
        }}
      >
        <p className="text-xs" style={{ color: "var(--v-bad-text)", lineHeight: 1.5 }}>
          This operation cannot be undone. Save a copy before proceeding.
        </p>
      </div>

      {/* Button */}
      <button
        className="v-btn-primary w-full"
        disabled={isProcessing}
        onClick={handleFlatten}
      >
        Flatten PDF
      </button>

      {/* Processing */}
      {isProcessing && (
        <div className="mt-2 v-panel-processing">
          {progress && progress.total > 1 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5 }}>
                <span style={{ color: "var(--fg2)" }}>{progress.message ?? "Processing…"}</span>
                <span style={{ color: "var(--fg1)" }}>
                  {Math.round((progress.current / progress.total) * 100)}%
                </span>
              </div>
              <div style={{ height: 4, borderRadius: 2, overflow: "hidden", background: "var(--line)" }}>
                <div
                  style={{
                    height: "100%",
                    borderRadius: 2,
                    width: `${Math.round((progress.current / progress.total) * 100)}%`,
                    background: "var(--accent)",
                    transition: "width 150ms ease",
                  }}
                />
              </div>
            </div>
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
            <span className="text-xs font-semibold">PDF flattened</span>
          </div>
          <p className="text-xs" style={{ color: "var(--v-ok-text)", opacity: 0.85 }}>
            All annotations and form fields have been merged into the page content.
          </p>
        </div>
      )}
    </div>
  );
}
