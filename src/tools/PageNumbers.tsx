import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { addPageNumbers, PageNumberOptions } from "../lib/tauri";

const POSITIONS: PageNumberOptions["position"][] = [
  "bottom-center", "bottom-left", "bottom-right",
  "top-center", "top-left", "top-right"
];

export default function PageNumbers() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const [startAt, setStartAt] = useState(1);
  const [position, setPosition] = useState<PageNumberOptions["position"]>("bottom-center");
  const [fontSize, setFontSize] = useState(10);
  const file = files[0]!;

  async function handleAdd() {
    if (!file) return;
    await run(() => addPageNumbers(file.path, { start_at: startAt, position, font_size: fontSize }));
  }

  return (
    <ToolLayout title="Add Page Numbers" description="Overlay page numbers on every page">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">{file.name}</p>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {/* Start at */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Start numbering at</label>
            <input
              type="number"
              min={1}
              value={startAt}
              onChange={(e) => setStartAt(Math.max(1, Math.min(9_999, Number(e.target.value))))}
              className="input w-24 text-sm"
            />
          </div>

          {/* Position */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Position</label>
            <div className="grid grid-cols-3 gap-2">
              {POSITIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  className={`py-1.5 text-xs rounded-lg border transition-colors ${
                    position === p
                      ? "bg-blue-500 text-white border-blue-500"
                      : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {p!.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")}
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Font size: {fontSize}pt</label>
            <input
              type="range"
              min={6}
              max={24}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <button
            disabled={!file || isProcessing}
            onClick={handleAdd}
            className="btn-primary w-full"
          >
            Add Page Numbers
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
