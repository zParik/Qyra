import { useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoadedFile } from "../../store/useAppStore";
import { addWatermark, showSaveDialog, copyFile } from "../../lib/tauri";
import type { WatermarkOptions } from "../../lib/tauri";
import { ProgressBar, Spinner } from "../../components/ProgressBar";
import { sanitizeError, type ProgressData } from "../usePanelCommand";

const PRESET_COLORS = [
  { label: "Gray",   value: "#888888" },
  { label: "Red",    value: "#cc0000" },
  { label: "Blue",   value: "#0055cc" },
  { label: "Black",  value: "#111111" },
];

const MODES: { value: WatermarkOptions["mode"]; label: string; desc: string }[] = [
  { value: "diagonal", label: "Diagonal", desc: "Centered, rotated" },
  { value: "center",   label: "Center",   desc: "Horizontal center" },
  { value: "tile",     label: "Tile",     desc: "Repeating grid" },
];

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function WatermarkPanel({ file, onApplied }: Props) {
  const [text, setText] = useState("CONFIDENTIAL");
  const [mode, setMode] = useState<WatermarkOptions["mode"]>("diagonal");
  const [opacity, setOpacity] = useState(25);        // 0–100 (sent as 0–1)
  const [fontSize, setFontSize] = useState(48);
  const [angle, setAngle] = useState(45);
  const [color, setColor] = useState("#888888");
  const [customColor, setCustomColor] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  async function handleApply() {
    if (!text.trim()) return;
    setError(null);
    setOutputPath(null);
    setProgress(null);
    setIsProcessing(true);

    const unlisten = await listen<ProgressData>("operation-progress", (e) => {
      setProgress(e.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const options: WatermarkOptions = {
        text: text.trim(),
        mode,
        opacity: opacity / 100,
        font_size: fontSize,
        angle: mode === "center" ? 0 : angle,
        color,
      };
      const out = await addWatermark(file.path, options);
      setOutputPath(out);
      onApplied(out);
    } catch (e) {
      setError(sanitizeError(e));
    } finally {
      setIsProcessing(false);
      setProgress(null);
      unlisten();
      unlistenRef.current = null;
    }
  }

  async function handleSaveAs() {
    if (!outputPath) return;
    const dest = await showSaveDialog(outputPath);
    if (dest) await copyFile(outputPath, dest);
  }

  return (
    <div className="space-y-4">
      {/* Watermark text */}
      <div>
        <label className="text-xs font-medium mb-1.5 block" style={{ color: "var(--viewer-text-sec)" }}>
          Watermark text
        </label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. CONFIDENTIAL"
          className="w-full rounded px-2.5 py-1.5 text-sm"
          style={{
            background: "var(--viewer-bg)",
            border: "1px solid var(--viewer-border)",
            color: "var(--viewer-text)",
            outline: "none",
            fontFamily: "inherit",
          }}
          maxLength={80}
        />
      </div>

      {/* Mode */}
      <div>
        <p className="text-xs font-medium mb-1.5" style={{ color: "var(--viewer-text-sec)" }}>
          Layout
        </p>
        <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--viewer-border)" }}>
          {MODES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className="flex-1 py-2 px-1 text-center text-xs transition-colors"
              style={
                mode === value
                  ? { background: "var(--viewer-accent)", color: "#fff" }
                  : {
                      background: "var(--viewer-bg)",
                      color: "var(--viewer-text-muted)",
                      borderLeft: value !== "diagonal" ? "1px solid var(--viewer-border)" : undefined,
                    }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Opacity */}
      <div>
        <div className="flex justify-between mb-1">
          <p className="text-xs font-medium" style={{ color: "var(--viewer-text-sec)" }}>Opacity</p>
          <p className="text-xs font-mono" style={{ color: "var(--viewer-text-muted)" }}>{opacity}%</p>
        </div>
        <input
          type="range" min={5} max={80} step={5}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="w-full"
          style={{ accentColor: "var(--viewer-accent)" }}
        />
      </div>

      {/* Font size */}
      <div>
        <div className="flex justify-between mb-1">
          <p className="text-xs font-medium" style={{ color: "var(--viewer-text-sec)" }}>Font size</p>
          <p className="text-xs font-mono" style={{ color: "var(--viewer-text-muted)" }}>{fontSize}pt</p>
        </div>
        <input
          type="range" min={12} max={120} step={4}
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="w-full"
          style={{ accentColor: "var(--viewer-accent)" }}
        />
      </div>

      {/* Angle — hidden when center mode */}
      {mode !== "center" && (
        <div>
          <div className="flex justify-between mb-1">
            <p className="text-xs font-medium" style={{ color: "var(--viewer-text-sec)" }}>Angle</p>
            <p className="text-xs font-mono" style={{ color: "var(--viewer-text-muted)" }}>{angle}°</p>
          </div>
          <input
            type="range" min={0} max={90} step={5}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="w-full"
            style={{ accentColor: "var(--viewer-accent)" }}
          />
        </div>
      )}

      {/* Color */}
      <div>
        <p className="text-xs font-medium mb-1.5" style={{ color: "var(--viewer-text-sec)" }}>Color</p>
        <div className="flex gap-1.5 flex-wrap">
          {PRESET_COLORS.map((c) => (
            <button
              key={c.value}
              title={c.label}
              onClick={() => { setColor(c.value); setCustomColor(false); }}
              style={{
                width: 24, height: 24, borderRadius: 4,
                background: c.value,
                border: color === c.value && !customColor
                  ? "2px solid var(--viewer-accent)"
                  : "2px solid transparent",
                outline: "none", cursor: "pointer",
                boxShadow: "0 0 0 1px var(--viewer-border)",
              }}
            />
          ))}
          {/* Custom color swatch */}
          <label
            title="Custom color"
            style={{
              width: 24, height: 24, borderRadius: 4, cursor: "pointer",
              border: customColor ? "2px solid var(--viewer-accent)" : "2px solid transparent",
              boxShadow: "0 0 0 1px var(--viewer-border)",
              overflow: "hidden", position: "relative", display: "block",
              background: customColor ? color : "linear-gradient(135deg, #f00 0%, #0f0 50%, #00f 100%)",
            }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => { setColor(e.target.value); setCustomColor(true); }}
              style={{ opacity: 0, position: "absolute", inset: 0, cursor: "pointer" }}
            />
          </label>
        </div>
      </div>

      {/* Apply */}
      <button
        onClick={handleApply}
        disabled={isProcessing || !text.trim()}
        className="v-btn-primary w-full"
      >
        Apply Watermark
      </button>

      {isProcessing && (
        <div className="mt-2 v-panel-processing">
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

      {error && !isProcessing && (
        <div className="mt-2 v-panel-bad space-y-1.5">
          <p className="text-xs font-semibold" style={{ color: "var(--v-bad-text)" }}>Error</p>
          <p className="text-xs wrap-break-word" style={{ color: "var(--v-bad-text)", opacity: 0.9 }}>
            {error}
          </p>
          <button onClick={() => setError(null)} className="text-xs underline" style={{ color: "var(--v-bad-text)" }}>
            Dismiss
          </button>
        </div>
      )}

      {outputPath && !isProcessing && !error && (
        <div className="mt-2 v-panel-ok space-y-2">
          <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs font-semibold">Watermark applied</span>
          </div>
          <button onClick={handleSaveAs} className="v-btn-secondary w-full text-xs">
            Save As…
          </button>
        </div>
      )}
    </div>
  );
}
