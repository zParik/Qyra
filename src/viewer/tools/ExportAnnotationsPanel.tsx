import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
}

export function ExportAnnotationsPanel({ file }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand();

  async function handleExport() {
    await run(async () => {
      const out = await invoke<string>("export_annotations", { path: file.path });
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
      submitLabel="Export Annotations (.csv)"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Exports every annotation (highlights, notes, shapes, free text) to a CSV file
        with page number, type, color, contents, and normalized coordinates.
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
