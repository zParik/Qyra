import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { compressPdf, cancelCompress } from "../../lib/tauri";
import { loadSetting, Settings } from "../../lib/settings";
import { sanitizeError, type ProgressData } from "../usePanelCommand";
import { StatusBox } from "../components/StatusBox";

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function savingsPct(original: number, compressed: number) {
  if (original === 0) return 0;
  return Math.round((1 - compressed / original) * 100);
}

type Level = 0 | 1 | 2;

const LEVELS = [
  { value: 0, label: "Lossless",   desc: "Lossless"      },
  { value: 1, label: "Lossy",      desc: "150 dpi · q78" },
  { value: 2, label: "Aggressive", desc: "72 dpi · q65"  },
] as const;

const LEVEL_DETAIL: Record<Level, string> = {
  0: "Re-compresses all streams at maximum zlib level and removes unused objects. No quality loss.",
  1: "Strips metadata and downsamples images to 150 dpi, re-encoding them as JPEG. Matches Ghostscript /ebook output size.",
  2: "Downsamples images to 72 dpi at lower JPEG quality. Smallest file — matches Ghostscript /screen.",
};

interface CompressPanelProps {
  file: LoadedFile;
  onApplied: (path: string, opts?: { saveAsNew?: boolean }) => void;
}

export function CompressPanel({ file, onApplied }: CompressPanelProps) {
  const [level, setLevel] = useState<Level>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ original: number; compressed: number } | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Seed from saved default (Settings → Files). Runs once on mount.
  useEffect(() => {
    let alive = true;
    loadSetting(Settings.defaultCompressLevel).then((l) => {
      if (alive) setLevel(l);
    });
    return () => { alive = false; };
  }, []);

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
      // Compress saves its result as a NEW file beside the original (never
      // overwrites) and opens it clean — no "unsaved" limbo.
      onApplied(result.path, { saveAsNew: true });
    } catch (e) {
      // User-initiated cancel is not an error.
      if (/cancel/i.test(String(e))) {
        setError(null);
      } else {
        setError(sanitizeError(e));
      }
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
      unlistenRef.current = null;
    }
  }

  return (
    <div className="space-y-4 pb-8">
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

      {/* Large-file notice */}
      {file.info &&
        (file.info.file_size > 10 * 1024 * 1024 || file.info.page_count > 50) && (
        <div
          className="rounded-md p-2.5 text-xs"
          style={{
            background: "rgba(96, 165, 250, 0.10)",
            border: "1px solid rgba(96, 165, 250, 0.30)",
            color: "var(--viewer-text)",
          }}
        >
          <p style={{ opacity: 0.85 }}>
            Large file — compression runs on several CPU cores at low priority, so
            it may take a while but keeps the app responsive. The panel shows live
            progress for each stage.
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
            <Spinner label={progress?.message} />
          )}
          <button
            className="v-btn-secondary"
            style={{ marginTop: 8, width: "auto", padding: "0 16px" }}
            onClick={() => { void cancelCompress(); }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error */}
      {error && !isProcessing && (
        <StatusBox status="error" message={error} onDismiss={() => setError(null)} />
      )}

      {/* Size result */}
      {sizes && !isProcessing && (
        <StatusBox
          status="success"
          message={
            <>
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
            </>
          }
        />
      )}
    </div>
  );
}
