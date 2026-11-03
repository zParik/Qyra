import { useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { DropZone } from "../components/DropZone";
import { PageGrid } from "../components/PageGrid";
import { useAppStore } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { mergePdfs, showSaveDialog } from "../lib/tauri";

export default function Merge() {
  // Per-field selectors: avoid re-rendering on unrelated store writes (e.g.
  // progress ticks fired by other code paths) — only `files`/`isProcessing` here change.
  const files = useAppStore((s) => s.files);
  const removeFile = useAppStore((s) => s.removeFile);
  const reorderFiles = useAppStore((s) => s.reorderFiles);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const reset = useAppStore((s) => s.reset);

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
    <ToolLayout title="Merge PDFs" description="Combine several PDFs into one, in the order you choose." family="pages">
      <DropZone multiple label="Drop PDF files here, or click to browse" />

      {files.length > 0 && (
        <section className="section">
          <header className="section-head">
            <h2>Order</h2>
            <span className="t-meta">{files.length} {files.length === 1 ? "file" : "files"} · drag to reorder</span>
            <span className="spacer" />
            <button type="button" onClick={clearFiles} className="btn-ghost btn-sm">Clear all</button>
          </header>
          <PageGrid files={files} onRemove={removeFile} onReorder={reorderFiles} />
          <div className="card" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)" }}>
            <span style={{ flex: 1, color: "var(--fg1)" }}>
              {files.length < 2 ? "Add at least two files to merge." : `Merge into one PDF of ${files.length} documents.`}
            </span>
            <button type="button" disabled={files.length < 2 || isProcessing} onClick={handleMerge} className="btn-primary">
              Merge {files.length} {files.length === 1 ? "PDF" : "PDFs"}
            </button>
          </div>
        </section>
      )}
    </ToolLayout>
  );
}
