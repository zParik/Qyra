import { useState, useRef } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { writeBytes, pickDirectory, showInFolder, shareFile } from "../../lib/tauri";
import { isAndroid } from "../../lib/androidFileUtils";
import { renderPageForExport } from "../../hooks/usePageThumbnails";

interface ExportImagesPanelProps {
  file: LoadedFile;
}

/** Parse a page range string like "1-3, 5, 7-9" into a sorted, deduplicated list of 1-indexed page numbers. */
function parsePageRange(input: string, total: number): number[] | null {
  const pages = new Set<number>();
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = part.match(/^(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10);
      const to = parseInt(rangeMatch[2], 10);
      if (from < 1 || to > total || from > to) return null;
      for (let i = from; i <= to; i++) pages.add(i);
    } else if (singleMatch) {
      const n = parseInt(singleMatch[1], 10);
      if (n < 1 || n > total) return null;
      pages.add(n);
    } else {
      return null;
    }
  }
  return [...pages].sort((a, b) => a - b);
}

export function ExportImagesPanel({ file }: ExportImagesPanelProps) {
  const [format, setFormat] = useState<"png" | "jpg">("png");
  const [dpi, setDpi] = useState(150);
  const [pageInput, setPageInput] = useState("");
  const [pageInputError, setPageInputError] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const pageCount = file.info?.page_count ?? 0;
  const stem = file.path.replace(/\\/g, "/").split("/").pop()?.replace(/\.pdf$/i, "") ?? "page";

  const resolvedPages: number[] | null =
    pageInput.trim() === ""
      ? Array.from({ length: pageCount }, (_, i) => i + 1)
      : parsePageRange(pageInput.trim(), pageCount);

  function handlePageInputChange(val: string) {
    setPageInput(val);
    setPageInputError(false);
    setProgress(null);
    setCancelled(false);
    setError(null);
  }

  async function handleExport() {
    if (!resolvedPages || resolvedPages.length === 0) {
      setPageInputError(true);
      return;
    }

    setError(null);
    setCancelled(false);
    cancelRef.current = false;

    let dir = outputDir;
    if (!dir) {
      dir = await pickDirectory();
      if (!dir) return;
      setOutputDir(dir);
    }

    setIsExporting(true);
    setProgress({ done: 0, total: resolvedPages.length });

    const scale = dpi / 72;
    const sep = dir.includes("/") ? "/" : "\\";
    const outputPaths: string[] = [];

    try {
      for (let idx = 0; idx < resolvedPages.length; idx++) {
        if (cancelRef.current) {
          setCancelled(true);
          break;
        }
        const pageNum = resolvedPages[idx];
        const bytes = await renderPageForExport(file.path, pageNum, scale, format);
        if (cancelRef.current) {
          setCancelled(true);
          break;
        }
        const filename = `${stem}_page${String(pageNum).padStart(4, "0")}.${format}`;
        const outPath = `${dir}${sep}${filename}`;
        await writeBytes(outPath, Array.from(bytes));
        outputPaths.push(outPath);
        setProgress({ done: idx + 1, total: resolvedPages.length });
      }
    } catch (e) {
      setError(String(e));
      setIsExporting(false);
      setProgress(null);
      return;
    }

    setIsExporting(false);
    if (!cancelRef.current && outputPaths.length > 0) {
      if (isAndroid()) {
        shareFile(outputPaths[0]).catch(() => {});
      } else {
        showInFolder(outputPaths[0]).catch(() => {});
      }
    }
  }

  function handleCancel() {
    cancelRef.current = true;
  }

  const isDone =
    progress !== null &&
    progress.done === progress.total &&
    !isExporting &&
    !cancelled;

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs mb-2 block" style={{ color: "var(--viewer-text-muted)" }}>
          Output format
        </label>
        <div className="flex gap-1.5">
          {(["png", "jpg"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              disabled={isExporting}
              className={`flex-1 py-1.5 text-sm rounded-lg transition-colors uppercase ${
                format === f ? "v-toggle-on" : "v-toggle-off"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
          Resolution: {dpi} DPI
        </label>
        <input
          type="range"
          min={72}
          max={600}
          step={1}
          value={dpi}
          disabled={isExporting}
          onChange={(e) => setDpi(Number(e.target.value))}
          className="w-full accent-(--action)"
        />
        <div className="flex justify-between text-xs mt-0.5" style={{ color: "var(--viewer-text-muted)" }}>
          <span>72</span>
          <span>150</span>
          <span>300</span>
          <span>600</span>
        </div>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
          Pages{pageCount > 0 ? ` (1–${pageCount})` : ""}
        </label>
        <input
          type="text"
          placeholder={`All pages${pageCount > 0 ? ` (1–${pageCount})` : ""}`}
          value={pageInput}
          disabled={isExporting}
          onChange={(e) => handlePageInputChange(e.target.value)}
          className="w-full text-sm px-2 py-1.5 rounded-lg"
          style={{
            background: "var(--viewer-input-bg, var(--viewer-bg))",
            border: `1px solid ${pageInputError ? "var(--viewer-error, #c00)" : "var(--viewer-border)"}`,
            color: "var(--viewer-text)",
            outline: "none",
          }}
        />
        {pageInputError ? (
          <p className="text-xs mt-1" style={{ color: "var(--viewer-error, #c00)" }}>
            Invalid range — use e.g. "1-3, 5, 8-10"
          </p>
        ) : resolvedPages && pageInput.trim() !== "" ? (
          <p className="text-xs mt-1" style={{ color: "var(--viewer-text-muted)" }}>
            {resolvedPages.length} page{resolvedPages.length !== 1 ? "s" : ""} selected
          </p>
        ) : null}
      </div>

      {outputDir && (
        <div className="flex items-center gap-2">
          <p
            className="text-xs truncate flex-1"
            style={{ color: "var(--viewer-text-muted)" }}
            title={outputDir}
          >
            → {outputDir}
          </p>
          <button
            onClick={() => setOutputDir(null)}
            disabled={isExporting}
            className="text-xs shrink-0"
            style={{ color: "var(--viewer-text-muted)" }}
          >
            change
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <button
          disabled={isExporting || pageCount === 0}
          onClick={handleExport}
          className="v-btn-primary flex-1"
        >
          Export Images
        </button>
        {isExporting && (
          <button
            onClick={handleCancel}
            className="v-btn-secondary px-3"
          >
            Cancel
          </button>
        )}
      </div>

      {isExporting && progress && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--viewer-border)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${(progress.done / progress.total) * 100}%`,
                background: "var(--action)",
              }}
            />
          </div>
          <p className="text-xs text-center" style={{ color: "var(--viewer-text-muted)" }}>
            {progress.done} / {progress.total}
          </p>
        </div>
      )}

      {isDone && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
          Exported {progress!.total} image{progress!.total !== 1 ? "s" : ""} — folder opened
        </p>
      )}

      {cancelled && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>
          Cancelled — {progress?.done ?? 0} image{(progress?.done ?? 0) !== 1 ? "s" : ""} saved
        </p>
      )}

      {error && (
        <div
          className="text-xs p-2 rounded"
          style={{ background: "var(--viewer-error-bg, #fee)", color: "var(--viewer-error, #c00)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
