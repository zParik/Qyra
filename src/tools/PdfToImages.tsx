import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { pdfToImages } from "../lib/tauri";

export default function PdfToImages() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const [format, setFormat] = useState<"png" | "jpg">("png");
  const [dpi, setDpi] = useState(150);
  const file = files[0]!;

  async function handleConvert() {
    if (!file) return;
    await run(() => pdfToImages(file.path, format, dpi));
  }

  return (
    <ToolLayout title="PDF to Images" description="Export each page as a PNG or JPG image">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400">{file.info?.page_count ?? "?"} pages</p>
            </div>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {/* Format */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Output format</label>
            <div className="flex gap-2">
              {(["png", "jpg"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-colors uppercase ${
                    format === f
                      ? "bg-blue-500 text-white border-blue-500"
                      : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* DPI */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Resolution: {dpi} DPI</label>
            <input
              type="range"
              min={72}
              max={600}
              step={1}
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-400">
              <span>72 (screen)</span>
              <span>150 (default)</span>
              <span>300 (print)</span>
              <span>600 (high)</span>
            </div>
          </div>

          <button
            disabled={!file || isProcessing}
            onClick={handleConvert}
            className="btn-primary w-full"
          >
            Export Images
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
