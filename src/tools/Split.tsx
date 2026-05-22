import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { splitPdf, splitPdfPerPage, splitPdfByBookmarks, PageRange } from "../lib/tauri";

type SplitMode = "ranges" | "per-page" | "every-n" | "bookmarks";

interface OutlineNode {
  title: string;
  page: number | null;
  items: OutlineNode[];
}

function flatOutline(nodes: OutlineNode[], depth = 0): { title: string; page: number | null; depth: number }[] {
  return nodes.flatMap((n) => [{ title: n.title, page: n.page, depth }, ...flatOutline(n.items, depth + 1)]);
}

export default function Split() {
  const { files, clearFiles, isProcessing } = useAppStore();
  const { run } = usePdfCommand();
  const [mode, setMode] = useState<SplitMode>("ranges");
  const [rangeText, setRangeText] = useState("1-3, 4-6");
  const [everyN, setEveryN] = useState(1);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [outlineLoaded, setOutlineLoaded] = useState(false);

  const file = files[0]!;
  const pageCount = file?.info?.page_count ?? 0;

  useEffect(() => {
    if (!file?.path || mode !== "bookmarks") return;
    setOutlineLoaded(false);
    invoke<OutlineNode[]>("get_outline", { path: file.path })
      .then((nodes) => { setOutline(nodes); setOutlineLoaded(true); })
      .catch(() => { setOutline([]); setOutlineLoaded(true); });
  }, [file?.path, mode]);

  function parseRanges(text: string): PageRange[] {
    const maxPage = pageCount || 10_000;
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((s) => {
        const parts = s.split("-").map(Number);
        const a = parts[0];
        const end = parts[1] ?? parts[0];
        if (a === undefined || end === undefined || isNaN(a) || isNaN(end) || a < 1 || end < a || end > maxPage) return [];
        return [{ start: a, end }];
      });
  }

  function buildEveryNRanges(): PageRange[] {
    const ranges: PageRange[] = [];
    for (let i = 1; i <= pageCount; i += everyN) {
      ranges.push({ start: i, end: Math.min(i + everyN - 1, pageCount) });
    }
    return ranges;
  }

  async function handleSplit() {
    if (!file) return;
    if (mode === "per-page") {
      await run(() => splitPdfPerPage(file.path));
    } else if (mode === "bookmarks") {
      await run(() => splitPdfByBookmarks(file.path));
    } else {
      const ranges = mode === "ranges" ? parseRanges(rangeText) : buildEveryNRanges();
      await run(() => splitPdf(file.path, ranges));
    }
  }

  return (
    <ToolLayout title="Split PDF" description="Extract pages or split into multiple files">
      {files.length === 0 ? (
        <DropZone multiple={false} />
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400">{pageCount} pages</p>
            </div>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
          </div>
        </div>
      )}

      {file && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          {/* Mode selector */}
          <div className="flex flex-wrap gap-2">
            {(["ranges", "per-page", "every-n", "bookmarks"] as SplitMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  mode === m
                    ? "bg-blue-500 text-white border-blue-500"
                    : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400"
                }`}
              >
                {m === "ranges" ? "Page Ranges" : m === "per-page" ? "Per Page" : m === "every-n" ? "Every N Pages" : "By Bookmarks"}
              </button>
            ))}
          </div>

          {mode === "ranges" && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">
                Page ranges (e.g. 1-3, 4-6, 7)
              </label>
              <input
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                className="input w-full text-sm"
                placeholder="1-3, 4-6"
              />
            </div>
          )}

          {mode === "every-n" && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Split every N pages</label>
              <input
                type="number"
                min={1}
                max={pageCount || 100}
                value={everyN}
                onChange={(e) => setEveryN(Math.max(1, Math.min(pageCount || 100, Number(e.target.value))))}
                className="input w-24 text-sm"
              />
            </div>
          )}

          {mode === "per-page" && (
            <p className="text-xs text-gray-400">
              Will create {pageCount} individual PDF files, one per page.
            </p>
          )}

          {mode === "bookmarks" && (() => {
            const flat = flatOutline(outline);
            return (
              <div>
                {!outlineLoaded ? (
                  <p className="text-xs text-gray-400">Loading bookmarks…</p>
                ) : flat.length === 0 ? (
                  <p className="text-xs text-gray-400">No bookmarks found in this document.</p>
                ) : (
                  <div className="space-y-0.5 max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                    {flat.map((n, i) => (
                      <div key={i} className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
                        style={{ paddingLeft: n.depth * 12 }}>
                        <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 16 16">
                          <path d="M3 4h10M3 8h6" strokeLinecap="round" />
                        </svg>
                        <span className="truncate flex-1">{n.title}</span>
                        {n.page != null && <span className="text-gray-400 shrink-0">p.{n.page}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-2">One output file per top-level bookmark.</p>
              </div>
            );
          })()}

          <button
            disabled={!file || isProcessing || (mode === "bookmarks" && outlineLoaded && flatOutline(outline).length === 0)}
            onClick={handleSplit}
            className="btn-primary w-full"
          >
            Split PDF
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
