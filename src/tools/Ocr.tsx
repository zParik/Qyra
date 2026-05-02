import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { makeSearchable, showSaveDialog, openFile, copyFile } from "../lib/tauri";
import { loadDocument } from "../hooks/usePageThumbnails";
import { ocrImage, getOcrWorker } from "../lib/ocrEngine";
import type { OcrPage } from "../lib/tauri";

const UI = "'Inter', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

type Status = "idle" | "processing" | "done" | "error";

interface OcrProgress {
  stage: string;
  page: number;
  total: number;
  pct: number;
}

interface OcrResult {
  outputPath: string;
  wordCount: number;
  pageCount: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Ocr() {
  const { files, clearFiles } = useAppStore();
  const file = files[0];

  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runOcr() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);

    try {
      // Step 1: load PDF
      setProgress({ stage: "Loading PDF…", page: 0, total: 0, pct: 2 });
      const pdfDoc = await loadDocument(file.path);
      const totalPages = pdfDoc.numPages;

      // Step 2: warm up the OCR worker (may download the English model ~10 MB on first use)
      setProgress({ stage: "Initializing OCR engine…", page: 0, total: totalPages, pct: 5 });
      await getOcrWorker((pct, stage) => {
        setProgress({
          stage: `${stage.charAt(0).toUpperCase() + stage.slice(1)}…`,
          page: 0,
          total: totalPages,
          pct: 5 + pct * 20,
        });
      });

      // Step 3: render + OCR each page
      const ocrPages: OcrPage[] = [];
      let totalWords = 0;

      for (let i = 1; i <= totalPages; i++) {
        setProgress({
          stage: `Recognizing page ${i} of ${totalPages}`,
          page: i,
          total: totalPages,
          pct: 25 + ((i - 1) / totalPages) * 65,
        });

        const page = await pdfDoc.getPage(i);

        // Render at 2× scale for better OCR accuracy (~144 DPI for a 72 DPI PDF)
        const scale = 2.0;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");

        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        const res = await ocrImage(canvas, canvas.width, canvas.height);

        ocrPages.push({
          words: res.words
            .filter((w) => w.confidence > 30)
            .map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })),
        });
        totalWords += ocrPages[i - 1].words.length;
      }

      // Step 4: embed text layer via Rust
      setProgress({ stage: "Embedding text layer…", page: totalPages, total: totalPages, pct: 92 });
      const outputPath = await makeSearchable(file.path, ocrPages);

      setProgress({ stage: "Done", page: totalPages, total: totalPages, pct: 100 });
      setResult({ outputPath, wordCount: totalWords, pageCount: totalPages });
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }

  async function handleSaveAs() {
    if (!result) return;
    const dest = await showSaveDialog(result.outputPath);
    if (dest) await copyFile(result.outputPath, dest);
  }

  return (
    <ToolLayout title="Make Searchable" description="Add OCR text layer to scanned PDFs">
      {!file ? (
        <DropZone multiple={false} label="Drop a scanned PDF here or click to browse" />
      ) : (
        <div style={{
          background: "var(--bg1)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}>
          {/* File header */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontFamily: UI, fontSize: 13.5, fontWeight: 600, color: "var(--fg0)" }}>
                {file.name}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", marginTop: 3 }}>
                {file.info?.page_count != null ? `${file.info.page_count} pages` : ""}
                {file.info?.file_size != null ? ` · ${formatBytes(file.info.file_size)}` : ""}
              </div>
            </div>
            {(status === "idle" || status === "error") && (
              <button
                onClick={clearFiles}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)",
                  padding: "2px 6px",
                }}
              >
                Remove
              </button>
            )}
          </div>

          {/* How-it-works note */}
          {status === "idle" && (
            <div style={{
              padding: "10px 12px",
              background: "var(--bg2)",
              border: "1px solid var(--line2)",
              borderRadius: 5,
              fontFamily: MONO,
              fontSize: 10.5,
              color: "var(--fg2)",
              lineHeight: 1.55,
            }}>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>OCR</span>
              {" · "}Renders each page, runs Tesseract to extract text, then embeds
              an invisible text layer — the result looks identical but is fully searchable.
              <br />
              <span style={{ color: "var(--fg3)" }}>Requires internet on first use to download the ~10 MB English model.</span>
            </div>
          )}

          {/* Progress */}
          {status === "processing" && progress && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: UI, fontSize: 12.5, color: "var(--fg1)" }}>
                  {progress.stage}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg2)" }}>
                  {Math.round(progress.pct)}%
                </span>
              </div>
              <div style={{
                height: 3,
                background: "var(--bg3)",
                borderRadius: 2,
                overflow: "hidden",
              }}>
                <div style={{
                  width: `${progress.pct}%`,
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: 2,
                  transition: "width 250ms ease",
                }} />
              </div>
              {progress.total > 0 && progress.page > 0 && (
                <div style={{
                  fontFamily: MONO, fontSize: 10, color: "var(--fg3)",
                  textAlign: "right", textTransform: "uppercase", letterSpacing: 0.5,
                }}>
                  Page {progress.page} / {progress.total}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <div style={{
              padding: "10px 12px",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 4,
              fontFamily: MONO, fontSize: 11, color: "#ef4444",
              lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          {/* Result */}
          {status === "done" && result && (
            <div style={{
              background: "var(--bg2)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {([
                  ["Pages", result.pageCount],
                  ["Words", result.wordCount.toLocaleString()],
                  ["Status", "Searchable"],
                ] as [string, string | number][]).map(([label, value]) => (
                  <div key={label} style={{
                    padding: "8px 10px",
                    background: "var(--bg1)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                  }}>
                    <div style={{
                      fontFamily: MONO, fontSize: 9, color: "var(--fg3)",
                      textTransform: "uppercase", letterSpacing: 0.6,
                    }}>
                      {label}
                    </div>
                    <div style={{
                      fontFamily: MONO, fontSize: 14, fontWeight: 600,
                      color: label === "Status" ? "var(--accent)" : "var(--fg0)",
                      marginTop: 2,
                    }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => openFile(result.outputPath)}
                  className="btn-primary"
                  style={{ flex: 1 }}
                >
                  Open
                </button>
                <button
                  onClick={handleSaveAs}
                  className="btn-secondary"
                  style={{ flex: 1 }}
                >
                  Save As…
                </button>
              </div>
            </div>
          )}

          {/* Primary action */}
          {(status === "idle" || status === "error") && (
            <button
              onClick={runOcr}
              className="btn-primary"
              disabled={!file}
            >
              Make Searchable
            </button>
          )}
        </div>
      )}
    </ToolLayout>
  );
}
