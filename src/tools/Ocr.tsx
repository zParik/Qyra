import { useState } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { useAppStore } from "../store/useAppStore";
import { invoke } from "@tauri-apps/api/core";
import { makeSearchable, ocrPage, showSaveDialog, openFile, copyFile } from "../lib/tauri";
import type { OcrPage } from "../lib/tauri";

import { UI } from "../lib/tokens";

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
  const files = useAppStore((s) => s.files);
  const clearFiles = useAppStore((s) => s.clearFiles);
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
      const totalPages = await invoke<number>("get_page_count", { path: file.path });

      // Step 2: recognize each page in Rust (MuPDF's tesseract, bundled English model)
      const ocrPages: OcrPage[] = [];
      let totalWords = 0;

      for (let i = 1; i <= totalPages; i++) {
        setProgress({
          stage: `Recognizing page ${i} of ${totalPages}`,
          page: i,
          total: totalPages,
          pct: 5 + ((i - 1) / totalPages) * 85,
        });
        const page = await ocrPage(file.path, i);
        ocrPages.push(page);
        totalWords += page.words.length;
      }

      // Step 3: embed text layer via Rust
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
    <ToolLayout title="Make searchable" description="Add an OCR text layer to a scanned PDF, fully offline." family="export">
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
              <div style={{ fontFamily: UI, fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--fg0)" }}>
                {file.name}
              </div>
              <div style={{ fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg2)", marginTop: 3 }}>
                {file.info?.page_count != null ? `${file.info.page_count} pages` : ""}
                {file.info?.file_size != null ? ` · ${formatBytes(file.info.file_size)}` : ""}
              </div>
            </div>
            {(status === "idle" || status === "error") && (
              <button
                onClick={clearFiles}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg2)",
                  padding: "2px 6px",
                }}
              >
                Remove
              </button>
            )}
          </div>


          {/* Progress */}
          {status === "processing" && progress && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: UI, fontSize: "var(--fs-body)", color: "var(--fg1)" }}>
                  {progress.stage}
                </span>
                <span style={{ fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg2)" }}>
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
                  fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg3)",
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
              background: "var(--bad-soft)",
              border: "1px solid var(--bad-line)",
              borderRadius: 4,
              fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--bad)",
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
                      fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg3)",
                      textTransform: "uppercase", letterSpacing: 0.6,
                    }}>
                      {label}
                    </div>
                    <div style={{
                      fontFamily: UI, fontSize: 14, fontWeight: 600,
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
            >
              Make Searchable
            </button>
          )}
        </div>
      )}
    </ToolLayout>
  );
}
