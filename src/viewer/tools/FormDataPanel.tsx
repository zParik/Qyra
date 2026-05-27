import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function FormDataPanel({ file, onApplied }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [flatten, setFlatten] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);

  async function handleExport() {
    setExportPath(null);
    const defaultName = file.name.replace(/\.pdf$/i, ".xfdf");
    const dest = await save({
      defaultPath: defaultName,
      filters: [{ name: "XFDF form data", extensions: ["xfdf"] }],
    });
    if (!dest) return;
    await run(async () => {
      const out = await invoke<string>("export_form_xfdf", {
        path: file.path,
        output: dest,
      });
      setExportPath(out);
      // Result toast uses the source PDF path so onApplied does not navigate.
      return file.path;
    });
  }

  async function handleImport() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "XFDF form data", extensions: ["xfdf", "fdf", "xml"] }],
    });
    if (!picked) return;
    const xfdfPath = Array.isArray(picked) ? picked[0]! : picked;
    await run(async () => {
      const out = await invoke<string>("import_form_xfdf", {
        pdfPath: file.path,
        xfdfPath,
        flatten,
      });
      return out;
    });
  }

  return (
    <ToolPanelLayout
      onSubmit={handleExport}
      submitLabel="Export to XFDF…"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Export the current form field values to an Adobe-compatible XFDF file,
        or import an XFDF file to bulk-populate fields by matching name.
      </p>

      {exportPath && (
        <div
          style={{
            border: "1px solid var(--v-ok-border)",
            background: "var(--v-ok-bg)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--v-ok-text)",
            fontSize: 11.5,
            wordBreak: "break-all",
          }}
        >
          Exported to <code>{exportPath}</code>
        </div>
      )}

      <div
        style={{
          borderTop: "1px solid var(--viewer-border-sub)",
          paddingTop: 10,
          display: "flex", flexDirection: "column", gap: 8,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={flatten}
            onChange={(e) => setFlatten(e.target.checked)}
          />
          <span style={{ color: "var(--viewer-text)" }}>
            Flatten after import (bake values into page content)
          </span>
        </label>
        <button
          type="button"
          onClick={handleImport}
          disabled={isProcessing}
          className="v-btn-secondary w-full"
          style={{
            padding: "8px 12px",
            background: "var(--viewer-elevated)",
            color: "var(--viewer-text)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6,
            fontSize: 12.5,
            cursor: isProcessing ? "not-allowed" : "pointer",
          }}
        >
          Import from XFDF…
        </button>
      </div>
    </ToolPanelLayout>
  );
}
