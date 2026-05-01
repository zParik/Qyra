import { useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { PageGrid } from "../components/PageGrid";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { mergePdfs, showSaveDialog } from "../lib/tauri";

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const UI   = "'Inter', system-ui, sans-serif";

export default function Merge() {
  const { files, removeFile, reorderFiles, clearFiles, isProcessing, reset } = useAppStore();

  useEffect(() => {
    clearFiles();
    reset();
  }, []);
  const { run } = usePdfCommand();

  async function handleMerge() {
    if (files.length < 2) return;
    const savePath = await showSaveDialog("merged.pdf");
    if (!savePath) return;
    await run(() => mergePdfs(files.map((f) => f.path), savePath));
  }

  return (
    <ToolLayout title="Merge PDFs" description="Combine multiple PDF files into one">
      <DropZone multiple label="Drop PDF files here or click to browse" />

      {files.length > 0 && (
        <>
          <PageGrid files={files} onRemove={removeFile} onReorder={reorderFiles} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button
              onClick={clearFiles}
              style={{
                background: "transparent", border: "none",
                fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", cursor: "pointer",
                padding: "4px 0",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg2)")}
            >
              Clear all
            </button>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>
              {files.length} file{files.length !== 1 ? "s" : ""} queued
            </span>
          </div>
        </>
      )}

      {files.length > 0 && (
        <div style={{
          padding: 16, background: "var(--bg1)",
          border: "1px solid var(--line)", borderRadius: 6,
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <button
            disabled={files.length < 2 || isProcessing}
            onClick={handleMerge}
            style={{
              background: files.length < 2 || isProcessing ? "var(--action-dim)" : "var(--accent)",
              color: "var(--accent-text)",
              border: "none", borderRadius: 4, padding: "0 16px", height: 32,
              fontFamily: UI, fontSize: 13, fontWeight: 600, cursor: files.length < 2 || isProcessing ? "not-allowed" : "pointer",
              width: "100%", transition: "background 120ms",
            }}
          >
            Merge {files.length} PDF{files.length !== 1 ? "s" : ""}
          </button>
          {files.length < 2 && (
            <p style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", textAlign: "center", margin: 0 }}>
              Add at least 2 files to merge
            </p>
          )}
        </div>
      )}
    </ToolLayout>
  );
}
