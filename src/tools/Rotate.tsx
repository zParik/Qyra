import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { rotatePages } from "../lib/tauri";

const DEGREES = [90, 180, 270] as const;

export default function Rotate() {
  const { files, clearFiles, isProcessing } = useAppStore();
  const { run } = usePdfCommand();
  const [degrees, setDegrees] = useState<90 | 180 | 270>(90);
  const [applyTo, setApplyTo] = useState<"all" | "specific">("all");
  const [pageList, setPageList] = useState("1");
  const file = files[0]!;
  const pageCount = file?.info?.page_count ?? 0;

  function parsePages(text: string): number[] {
    const MAX_PAGE = pageCount || 10_000;
    const pages: number[] = [];
    for (const part of text.split(",").map((s) => s.trim())) {
      if (part.includes("-")) {
        const [a, b] = part.split("-").map(Number);
        if (a !== undefined && b !== undefined && !isNaN(a) && !isNaN(b) && a >= 1 && b >= a && b <= MAX_PAGE) {
          for (let i = a; i <= b; i++) pages.push(i);
        }
      } else {
        const n = Number(part);
        if (!isNaN(n) && n >= 1 && n <= MAX_PAGE) pages.push(n);
      }
    }
    return [...new Set(pages)];
  }

  async function handleRotate() {
    if (!file) return;
    const pages = applyTo === "all" ? [] : parsePages(pageList);
    await run(() => rotatePages(file.path, pages, degrees));
  }

  return (
    <ToolLayout title="Rotate Pages" description="Rotate all or specific pages by 90°, 180°, or 270°">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">{file.name}</p>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          {/* Degree selector */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Rotation</label>
            <div className="flex gap-2">
              {DEGREES.map((d) => (
                <button
                  key={d}
                  onClick={() => setDegrees(d)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                    degrees === d
                      ? "bg-blue-500 text-white border-blue-500"
                      : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {d}°
                </button>
              ))}
            </div>
          </div>

          {/* Apply to */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Apply to</label>
            <div className="flex gap-2">
              <button
                onClick={() => setApplyTo("all")}
                className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                  applyTo === "all"
                    ? "bg-blue-500 text-white border-blue-500"
                    : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                }`}
              >
                All pages
              </button>
              <button
                onClick={() => setApplyTo("specific")}
                className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${
                  applyTo === "specific"
                    ? "bg-blue-500 text-white border-blue-500"
                    : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                }`}
              >
                Specific pages
              </button>
            </div>
            {applyTo === "specific" && (
              <input
                className="input w-full mt-2 text-sm"
                placeholder="e.g. 1, 3-5, 7"
                value={pageList}
                onChange={(e) => setPageList(e.target.value)}
              />
            )}
          </div>

          <button
            disabled={!file || isProcessing}
            onClick={handleRotate}
            className="btn-primary w-full"
          >
            Rotate Pages
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
