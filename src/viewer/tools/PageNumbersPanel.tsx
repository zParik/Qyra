import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { PanelOutput } from "../PanelOutput";
import { addPageNumbers, removePageNumbers, PageNumberOptions } from "../../lib/tauri";

const POSITIONS: PageNumberOptions["position"][] = [
  "bottom-center", "bottom-left", "bottom-right",
  "top-center", "top-left", "top-right",
];

interface PageNumbersPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function PageNumbersPanel({ file, onApplied }: PageNumbersPanelProps) {
  const { isProcessing, result, error, progress, run, clearError } = usePanelCommand(onApplied);
  const [startAt, setStartAt] = useState(1);
  const [position, setPosition] = useState<PageNumberOptions["position"]>("bottom-center");
  const [fontSize, setFontSize] = useState(10);

  async function handle() {
    await run(() => addPageNumbers(file.path, { start_at: startAt, position, font_size: fontSize }));
  }

  async function handleRemove() {
    await run(() => removePageNumbers(file.path));
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>Start numbering at</label>
        <input
          type="number"
          min={1}
          value={startAt}
          onChange={(e) => setStartAt(Math.max(1, Math.min(9_999, Number(e.target.value))))}
          className="v-input w-20"
        />
      </div>

      <div>
        <label className="text-xs mb-2 block" style={{ color: "var(--viewer-text-muted)" }}>Position</label>
        <div className="grid grid-cols-3 gap-1.5">
          {POSITIONS.map((p) => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              className={`py-1.5 text-xs rounded-lg transition-colors ${
                position === p ? "v-toggle-on" : "v-toggle-off"
              }`}
            >
              {p!.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>Font size: {fontSize}pt</label>
        <input
          type="range"
          min={6}
          max={24}
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="w-full accent-(--action)"
        />
      </div>

      <div className="flex gap-2">
        <button
          disabled={isProcessing}
          onClick={handle}
          className="v-btn-primary flex-1"
        >
          Add
        </button>
        <button
          disabled={isProcessing}
          onClick={handleRemove}
          className="v-btn-secondary-sm flex-1 py-2 text-sm font-medium rounded-lg"
        >
          Remove
        </button>
      </div>

      <PanelOutput
        isProcessing={isProcessing}
        result={result}
        error={error}
        onClearError={clearError}
        progress={progress}
      />
    </div>
  );
}
