import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import {
  splitPdf,
  splitPdfPerPage,
  splitPdfByBookmarks,
  pickDirectory,
  PageRange,
} from "../../lib/tauri";

interface SplitPanelProps {
  file: LoadedFile;
  splitAfter: number;
  onSplitAfterChange: (n: number) => void;
}

type Mode = "after" | "per-page" | "bookmarks";

export function SplitPanel({ file, splitAfter, onSplitAfterChange }: SplitPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand();
  const pageCount = file.info?.page_count ?? 0;
  const [mode, setMode] = useState<Mode>("after");

  const clamped = Math.max(1, Math.min(splitAfter, pageCount - 1));
  const part1Count = clamped;
  const part2Count = pageCount - clamped;

  async function handle() {
    if (pageCount < 2) return;
    const dir = await pickDirectory();
    if (!dir) return;
    if (mode === "per-page") {
      await run(() => splitPdfPerPage(file.path, dir));
      return;
    }
    if (mode === "bookmarks") {
      await run(() => splitPdfByBookmarks(file.path, dir));
      return;
    }
    const ranges: PageRange[] = [
      { start: 1, end: clamped },
      { start: clamped + 1, end: pageCount },
    ];
    await run(() => splitPdf(file.path, ranges, dir));
  }

  if (pageCount < 2) {
    return (
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
        Need at least 2 pages to split.
      </p>
    );
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Choose folder & Split"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
          Split mode
        </label>
        <div className="flex gap-1">
          {(["after", "per-page", "bookmarks"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="text-xs px-2 py-1 rounded flex-1"
              style={{
                background: mode === m ? "var(--accent)" : "var(--viewer-elevated)",
                color: mode === m ? "#fff" : "var(--viewer-text)",
                border: "1px solid var(--viewer-border)",
                cursor: "pointer",
              }}
            >
              {m === "after" ? "After page" : m === "per-page" ? "Per page" : "By bookmarks"}
            </button>
          ))}
        </div>
      </div>

      {mode === "after" && (
        <>
          <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
            {pageCount} pages total — click a page in the left panel to set the split point.
          </p>

          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
              Split after page
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={pageCount - 1}
                value={clamped}
                onChange={(e) =>
                  onSplitAfterChange(Math.max(1, Math.min(pageCount - 1, Number(e.target.value))))
                }
                className="v-input w-20"
              />
              <span className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>of {pageCount}</span>
            </div>
          </div>

          <div
            className="rounded-lg p-3 space-y-2"
            style={{ background: "var(--viewer-elevated)", border: "1px solid var(--viewer-border)" }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold w-12" style={{ color: "var(--action)" }}>Part 1</span>
              <span className="text-xs" style={{ color: "var(--viewer-text)" }}>
                {clamped === 1 ? "Page 1" : `Pages 1–${clamped}`}
              </span>
              <span className="text-xs ml-auto tabular-nums" style={{ color: "var(--viewer-text-muted)" }}>
                {part1Count} {part1Count === 1 ? "page" : "pages"}
              </span>
            </div>
            <div
              className="w-full"
              style={{ height: "1px", background: "var(--viewer-border)" }}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold w-12" style={{ color: "var(--brand)" }}>Part 2</span>
              <span className="text-xs" style={{ color: "var(--viewer-text)" }}>
                {clamped + 1 === pageCount ? `Page ${pageCount}` : `Pages ${clamped + 1}–${pageCount}`}
              </span>
              <span className="text-xs ml-auto tabular-nums" style={{ color: "var(--viewer-text-muted)" }}>
                {part2Count} {part2Count === 1 ? "page" : "pages"}
              </span>
            </div>
          </div>
        </>
      )}

      {mode === "per-page" && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
          Splits into {pageCount} individual files — one per page.
        </p>
      )}

      {mode === "bookmarks" && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
          One output file per top-level bookmark. Requires an /Outlines tree in the PDF.
        </p>
      )}
    </ToolPanelLayout>
  );
}
