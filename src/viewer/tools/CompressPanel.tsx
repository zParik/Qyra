import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { compressPdf, compressPdfGs, compressPdfGsParallel, cancelCompress, type GsPreset } from "../../lib/tauri";
import { isAndroid } from "../../lib/androidFileUtils";
import { loadSetting, Settings } from "../../lib/settings";
import { sanitizeError, type ProgressData } from "../usePanelCommand";
import { StatusBox } from "../components/StatusBox";

const GS_UNAVAILABLE = isAndroid();

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function savingsPct(original: number, compressed: number) {
  if (original === 0) return 0;
  return Math.round((1 - compressed / original) * 100);
}

type Engine = "rust" | "gs";
type Level = 0 | 1 | 2;

const LEVELS = [
  { value: 0, label: "Lossless",   desc: "Lossless"      },
  { value: 1, label: "Lossy",      desc: "JPEG 72%"      },
  { value: 2, label: "Aggressive", desc: "Grayscale 50%" },
] as const;

const LEVEL_DETAIL: Record<Level, string> = {
  0: "Re-compresses all streams at maximum zlib level and removes unused objects. No quality loss.",
  1: "Low + strips metadata, converts lossless images to JPEG at 72% quality, and downsamples images over 2048px.",
  2: "High + downsamples images to 1440px and converts them to grayscale at 50% quality.",
};

const GS_PRESETS: { value: GsPreset; label: string; desc: string }[] = [
  { value: "screen",   label: "Screen",   desc: "72 dpi"  },
  { value: "ebook",    label: "eBook",    desc: "150 dpi" },
  { value: "printer",  label: "Printer",  desc: "300 dpi" },
  { value: "prepress", label: "Prepress", desc: "300 dpi" },
];

const GS_PRESET_DETAIL: Record<GsPreset, string> = {
  screen:   "Smallest file. 72 dpi image downsampling, heavy JPEG compression. Best for email/web.",
  ebook:    "Balanced. 150 dpi downsampling, moderate JPEG. Default choice for most PDFs.",
  printer:  "Good print quality. 300 dpi downsampling. Use when output may be printed.",
  prepress: "Professional print. 300 dpi, color-preserved, embedded fonts. Largest of the four.",
};

interface CompressPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function CompressPanel({ file, onApplied }: CompressPanelProps) {
  // Ghostscript sidecar has no Android build — force Native on Android.
  const [engine, setEngine] = useState<Engine>("rust");
  const gsDisabled = GS_UNAVAILABLE;
  const [level, setLevel] = useState<Level>(0);
  const [preset, setPreset] = useState<GsPreset>("ebook");
  const [fastMode, setFastMode] = useState(false);
  const [turbo, setTurbo] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ original: number; compressed: number } | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Seed from saved defaults (Settings → Files). Runs once on mount.
  useEffect(() => {
    let alive = true;
    Promise.all([
      loadSetting(Settings.defaultCompressEngine),
      loadSetting(Settings.defaultCompressLevel),
      loadSetting(Settings.defaultCompressPreset),
    ]).then(([e, l, p]) => {
      if (!alive) return;
      if (!GS_UNAVAILABLE && e === "gs") setEngine("gs");
      setLevel(l);
      setPreset(p);
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
      const result =
        engine === "gs"
          ? fastMode
            ? await compressPdfGsParallel(file.path, undefined, preset, undefined, turbo)
            : await compressPdfGs(file.path, undefined, preset, turbo)
          : await compressPdf(file.path, undefined, level);
      setSizes({ original: result.original_bytes, compressed: result.compressed_bytes });
      onApplied(result.path);
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

      {/* Engine selector */}
      <div>
        <p className="text-xs font-medium mb-2" style={{ color: "var(--viewer-text-sec)" }}>
          Engine
        </p>
        <div
          className="flex rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--viewer-border)" }}
        >
          {(["rust", "gs"] as const).map((e, i) => {
            const disabled = e === "gs" && gsDisabled;
            return (
              <button
                key={e}
                disabled={disabled}
                onClick={() => !disabled && setEngine(e)}
                className="flex-1 py-2 px-1 text-center text-xs transition-colors"
                style={
                  engine === e
                    ? { background: "var(--viewer-accent)", color: "#fff" }
                    : {
                        background: "var(--viewer-bg)",
                        color: disabled
                          ? "var(--viewer-text-muted)"
                          : "var(--viewer-text-muted)",
                        opacity: disabled ? 0.5 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                        borderLeft: i > 0 ? "1px solid var(--viewer-border)" : undefined,
                      }
                }
              >
                <div className="font-semibold">{e === "rust" ? "Native" : "Ghostscript"}</div>
                <div style={{ opacity: 0.7 }}>
                  {e === "rust" ? "fast, text PDFs" : disabled ? "desktop only" : "image-heavy"}
                </div>
              </button>
            );
          })}
        </div>
        {gsDisabled && (
          <p className="text-xs mt-2" style={{ color: "var(--viewer-text-muted)" }}>
            Ghostscript compression is desktop-only. Android uses the Native zlib engine.
          </p>
        )}
      </div>

      {/* Ghostscript CPU/time warning. PDF size threshold ~10 MB or 50 pages
          is where wall-clock starts to feel painful on a typical laptop. */}
      {engine === "gs" && !gsDisabled && file.info &&
        (file.info.file_size > 10 * 1024 * 1024 || file.info.page_count > 50) && (
        <div
          className="rounded-md p-2.5 text-xs space-y-1"
          style={{
            background: "rgba(234, 179, 8, 0.10)",
            border: "1px solid rgba(234, 179, 8, 0.35)",
            color: "var(--viewer-text)",
          }}
        >
          <p className="font-semibold" style={{ color: "rgb(234, 179, 8)" }}>
            CPU-intensive operation
          </p>
          <p style={{ opacity: 0.85 }}>
            Ghostscript runs single-threaded. A {formatSize(file.info.file_size)} /{" "}
            {file.info.page_count}-page file may take{" "}
            <strong>30 seconds to several minutes</strong>. Runs at below-normal
            priority so the UI stays responsive, but your CPU will be busy.
          </p>
        </div>
      )}

      {/* Native large-file notice */}
      {engine === "rust" && file.info &&
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
            Large file — Native compression uses all CPU cores but may still take
            a while. The panel shows live progress for each stage.
          </p>
        </div>
      )}

      {/* Level / preset selector */}
      {engine === "rust" ? (
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
      ) : (
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: "var(--viewer-text-sec)" }}>
            Quality preset
          </p>
          <div
            className="grid grid-cols-2 gap-1 rounded-lg overflow-hidden"
            style={{ border: "1px solid var(--viewer-border)" }}
          >
            {GS_PRESETS.map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => setPreset(value)}
                className="py-2 px-1 text-center text-xs transition-colors"
                style={
                  preset === value
                    ? { background: "var(--viewer-accent)", color: "#fff" }
                    : { background: "var(--viewer-bg)", color: "var(--viewer-text-muted)" }
                }
              >
                <div className="font-semibold">{label}</div>
                <div style={{ opacity: 0.7 }}>{desc}</div>
              </button>
            ))}
          </div>
          <p className="text-xs mt-2" style={{ color: "var(--viewer-text-muted)" }}>
            {GS_PRESET_DETAIL[preset]}
          </p>

          {/* Fast (parallel) mode toggle */}
          <label
            className="flex items-start gap-2 mt-3 cursor-pointer"
            style={{ color: "var(--viewer-text-sec)" }}
          >
            <input
              type="checkbox"
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-xs">
              <span className="font-semibold" style={{ color: "var(--viewer-text)" }}>
                Fast mode (parallel)
              </span>
              <span className="block" style={{ opacity: 0.75 }}>
                Splits the PDF into 25-page chunks and compresses them on
                multiple CPU cores. Faster wall-clock on large files.
                <strong> Loses bookmarks, outline, form fields, and
                cross-page image deduplication</strong> — output may even be
                slightly larger than single-pass on PDFs that share images
                across pages.
              </span>
            </span>
          </label>

          {/* Turbo toggle — run Ghostscript at full speed (all cores, normal
              priority) instead of the default UI-friendly throttle. */}
          <label
            className="flex items-start gap-2 mt-3 cursor-pointer"
            style={{ color: "var(--viewer-text-sec)" }}
          >
            <input
              type="checkbox"
              checked={turbo}
              onChange={(e) => setTurbo(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-xs">
              <span className="font-semibold" style={{ color: "var(--viewer-text)" }}>
                Turbo (maximum speed)
              </span>
              <span className="block" style={{ opacity: 0.75 }}>
                Runs Ghostscript at normal priority across all CPU cores instead
                of the default low-priority throttle. Noticeably faster, but the
                app and the rest of your machine will feel busy while it runs.
              </span>
            </span>
          </label>
        </div>
      )}

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
          {engine === "rust" && (
            <button
              className="v-btn-secondary"
              style={{ marginTop: 8, width: "auto", padding: "0 16px" }}
              onClick={() => { void cancelCompress(); }}
            >
              Cancel
            </button>
          )}
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
