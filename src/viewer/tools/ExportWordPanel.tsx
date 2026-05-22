import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
}

export function ExportWordPanel({ file }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand();

  async function handleExport() {
    await run(async () => {
      const out = await invoke<string>("export_pdf_to_word", { path: file.path });
      try {
        await invoke("open_file", { path: out });
      } catch {
        // non-fatal
      }
      return out;
    });
  }

  return (
    <ToolPanelLayout
      onSubmit={handleExport}
      submitLabel="Export as Word (.docx)"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Extracts text and paragraphs from the PDF and saves as an editable Word document (.docx).
        Layout and images are not preserved — text only.
      </p>

      {file.info && (
        <div className="v-stat-box">
          <p className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
            Pages:{" "}
            <span style={{ color: "var(--viewer-text)" }}>{file.info.page_count}</span>
          </p>
        </div>
      )}
    </ToolPanelLayout>
  );
}
