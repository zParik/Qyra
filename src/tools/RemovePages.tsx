import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { removePages } from "../lib/tauri";

export default function RemovePages() {
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const { run } = usePdfCommand();
  const [pageList, setPageList] = useState("");
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
    return [...new Set(pages)].sort((a, b) => a - b);
  }

  const pagesToRemove = parsePages(pageList);

  async function handleRemove() {
    if (!file || pagesToRemove.length === 0) return;
    await run(() => removePages(file.path, pagesToRemove));
  }

  return (
    <ToolLayout title="Remove Pages" description="Delete specific pages from a PDF">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400">{pageCount} pages</p>
            </div>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              Pages to remove (e.g. 2, 4-6, 9)
            </label>
            <input
              className="input w-full text-sm"
              placeholder="e.g. 2, 4-6, 9"
              value={pageList}
              onChange={(e) => setPageList(e.target.value)}
            />
            {pagesToRemove.length > 0 && (
              <p className="text-xs text-gray-400 mt-1">
                Will remove pages: {pagesToRemove.join(", ")}
              </p>
            )}
          </div>

          <button
            disabled={!file || isProcessing || pagesToRemove.length === 0}
            onClick={handleRemove}
            className="btn-primary w-full"
          >
            Remove {pagesToRemove.length > 0 ? `${pagesToRemove.length} Page${pagesToRemove.length !== 1 ? "s" : ""}` : "Pages"}
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
