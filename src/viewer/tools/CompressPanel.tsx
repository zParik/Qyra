import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { PanelOutput } from "../PanelOutput";
import { compressPdf } from "../../lib/tauri";

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const LEVELS = [
  { value: 0, label: "Low",     desc: "Lossless"   },
  { value: 1, label: "High",    desc: "No metadata" },
  { value: 2, label: "Extreme", desc: "Grayscale"   },
] as const;

type Level = 0 | 1 | 2;

const LEVEL_DETAIL: Record<Level, string> = {
  0: "Object stream compression only. No quality loss.",
  1: "Low + strips XMP metadata, document info, and page thumbnails.",
  2: "High + converts all color images to grayscale JPEG for maximum reduction.",
};

interface CompressPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function CompressPanel({ file, onApplied }: CompressPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [level, setLevel] = useState<Level>(0);

  return (
    <div className="space-y-4">
      {file.info && (
        <div className="v-stat-box">
          <p className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
            Current size: <span style={{ color: "var(--viewer-text)" }}>{formatSize(file.info.file_size)}</span>
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
        onClick={() => run(() => compressPdf(file.path, undefined, level))}
        className="v-btn-primary"
      >
        Compress PDF
      </button>

      <PanelOutput
        isProcessing={isProcessing}
        result={result}
        error={error}
        onClearError={clearError}
      />
    </div>
  );
}
