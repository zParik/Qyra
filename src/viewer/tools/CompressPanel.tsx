import { useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { compressPdf } from "../../lib/tauri";
import { sanitizeError, type ProgressData } from "../usePanelCommand";

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function savingsPct(original: number, compressed: number) {
  if (original === 0) return 0;
  return Math.round((1 - compressed / original) * 100);
}

const LEVELS = [
  { value: 0, label: "Lossless",   desc: "Lossless"      },
  { value: 1, label: "Lossy",      desc: "JPEG 72%"      },
  { value: 2, label: "Aggressive", desc: "Grayscale 50%" },
] as const;

type Level = 0 | 1 | 2;

const LEVEL_DETAIL: Record<Level, string> = {
  0: "Re-compresses all streams at maximum zlib level and removes unused objects. No quality loss.",
  1: "Low + strips metadata, converts lossless images to JPEG at 72% quality, and downsamples images over 2048px.",
  2: "High + downsamples images to 1440px and converts them to grayscale at 50% quality.",
};

interface CompressPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function CompressPanel({ file, onApplied }: CompressPanelProps) {
  const [level, setLevel] = useState<Level>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ original: number; compressed: number } | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  async function handleCompress() {
    setError(null);
    setSizes(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (e) => {
      setProgress(e.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const result = await compressPdf(file.path, undefined, level);
      setSizes({ original: result.original_bytes, compressed: result.compressed_bytes });
      onApplied(result.path);
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
      unlistenRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      {file.info && (
        <div className="v-stat-box">
          <p className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
            Current size:{" "}
            <span style={{ color: "var(--viewer-text)" }}>{formatSize(file.info.file_size)}</span>
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--viewer-text-sec)" }}>
            Pages: <span style={{ color: "var(--viewer-text)" }}>{file.info.page_count}</span>
          </p>
        </div>
      )}

      {/* Level selector */}
      <div>
        <p className="text-xs font-medium mb-2" style={{ color: "var(--viewer-text-sec)" }}>
          Compression level
        </p>
        <div
          className="flex rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--viewer-border)" }}
        >
          {LEVELS.map(({ value, label, desc }) => (
            <button
              key={value}
              onClick={() => setLevel(value)}
              className="flex-1 py-2 px-1 text-center text-xs transition-colors"
              style={
                level === value
                  ? { background: "var(--viewer-accent)", color: "#fff" }
                  : {
                      background: "var(--viewer-bg)",
                      color: "var(--viewer-text-muted)",
                      borderLeft: value > 0 ? "1px solid var(--viewer-border)" : undefined,
                    }
              }
            >
              <div className="font-semibold">{label}</div>
              <div style={{ opacity: 0.7 }}>{desc}</div>
            </button>
          ))}
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--viewer-text-muted)" }}>
          {LEVEL_DETAIL[level]}
        </p>
      </div>

      <button
        disabled={isProcessing}
        onClick={handleCompress}
        className="v-btn-primary"
      >
        Compress PDF
      </button>

      {/* Processing state */}
      {isProcessing && (
        <div className="mt-3 v-panel-processing">
          {progress && progress.total > 1 ? (
            <ProgressBar
              current={progress.current}
              total={progress.total}
              message={progress.message}
            />
          ) : (
            <Spinner />
          )}
        </div>
      )}

      {/* Error */}
      {error && !isProcessing && (
        <div className="mt-3 v-panel-bad space-y-1.5">
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

      {/* Size result */}
      {sizes && !isProcessing && (
        <div className="mt-3 v-panel-ok space-y-1.5">
          <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs font-semibold">Done</span>
          </div>
          <p className="text-xs" style={{ color: "var(--v-ok-text)" }}>
            {formatSize(sizes.original)}
            {" → "}
            <span className="font-semibold">{formatSize(sizes.compressed)}</span>
            {sizes.compressed < sizes.original && (
              <span style={{ opacity: 0.8 }}>
                {" "}(−{savingsPct(sizes.original, sizes.compressed)}%)
              </span>
            )}
            {sizes.compressed >= sizes.original && (
              <span style={{ opacity: 0.8 }}> (already optimal)</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
