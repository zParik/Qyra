import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { compressPdf } from "../lib/tauri";

const LEVELS = [
  {
    value: 0,
    label: "Lossless",
    desc: "Lossless",
    detail: "Re-compresses all streams at maximum zlib level and removes unused objects. No quality loss.",
  },
  {
    value: 1,
    label: "Lossy",
    desc: "JPEG 72%",
    detail: "Low + strips metadata, converts lossless images to JPEG at 72% quality, and downsamples images over 2048px.",
  },
  {
    value: 2,
    label: "Aggressive",
    desc: "Grayscale 50%",
    detail: "High + downsamples images to 1440px and converts them to grayscale at 50% quality.",
  },
] as const;

type Level = 0 | 1 | 2;

export default function Compress() {
  const { files, clearFiles, isProcessing } = useAppStore();
  const { run } = usePdfCommand();
  const file = files[0]!;
  const [level, setLevel] = useState<Level>(0);

  function formatSize(bytes: number) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  async function handleCompress() {
    if (!file) return;
    await run(() => compressPdf(file.path, undefined, level));
  }

  return (
    <ToolLayout title="Compress PDF" description="Reduce file size by choosing a compression level">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400">
                {file.info ? formatSize(file.info.file_size) : "Size unknown"} · {file.info?.page_count ?? "?"} pages
              </p>
            </div>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {/* Level selector */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Compression level</p>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              {LEVELS.map(({ value, label, desc }) => (
                <button
                  key={value}
                  onClick={() => setLevel(value)}
                  className={`flex-1 py-2 px-2 text-center text-xs transition-colors ${
                    level === value
                      ? "bg-indigo-600 text-white"
                      : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                  } ${value > 0 ? "border-l border-gray-200 dark:border-gray-700" : ""}`}
                >
                  <div className="font-semibold">{label}</div>
                  <div className={`opacity-75 ${level === value ? "" : "text-gray-400"}`}>{desc}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {LEVELS[level].detail}
            </p>
          </div>

          <button
            disabled={!file || isProcessing}
            onClick={handleCompress}
            className="btn-primary w-full"
          >
            Compress PDF
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
