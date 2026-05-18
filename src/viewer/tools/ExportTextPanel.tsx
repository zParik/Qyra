import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { Spinner } from "../../components/ProgressBar";
import { sanitizeError } from "../usePanelCommand";

interface Props {
  file: LoadedFile;
}

export function ExportTextPanel({ file }: Props) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [outputPath,   setOutputPath]   = useState<string | null>(null);

  async function handleExport() {
    setError(null);
    setOutputPath(null);
    setIsProcessing(true);

    try {
      const out = await invoke<string>("export_pdf_to_text", { path: file.path });
      setOutputPath(out);
      // Open the resulting text file with the system default application
      try {
        await invoke("open_file", { path: out });
      } catch {
        // Non-fatal: file was saved even if we can't open it
      }
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Extracts all text from each page and saves as a plain text file alongside the original PDF.
      </p>

      {/* File info */}
      {file.info && (
        <div className="v-stat-box">
          <p className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
            Pages:{" "}
            <span style={{ color: "var(--viewer-text)" }}>{file.info.page_count}</span>
          </p>
        </div>
      )}

      {/* Export button */}
      <button
        className="v-btn-primary w-full"
        disabled={isProcessing}
        onClick={handleExport}
      >
        Export as Text
      </button>

      {/* Spinner */}
      {isProcessing && (
        <div className="mt-2 v-panel-processing">
          <Spinner label="Extracting text…" />
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
        <div className="mt-2 v-panel-ok space-y-2">
          <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs font-semibold">Text exported</span>
          </div>
          <p
            className="text-xs wrap-break-word"
            style={{ color: "var(--v-ok-text)", opacity: 0.85, fontFamily: "monospace", wordBreak: "break-all" }}
          >
            Saved to: {outputPath}
          </p>
          <button
            onClick={() => invoke("open_file", { path: outputPath }).catch(() => {})}
            className="v-btn-secondary w-full text-xs"
          >
            Open File
          </button>
        </div>
      )}
    </div>
  );
}
