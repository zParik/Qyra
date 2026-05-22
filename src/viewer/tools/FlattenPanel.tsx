import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { IconCheck } from "../icons";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

const CHECKLIST = [
  "Form fields → baked in",
  "PDF annotations → baked in",
  "AcroForm dictionary → removed",
];

export function FlattenPanel({ file, onApplied }: Props) {
  const { isProcessing, result, error, progress, run, clearError } = usePanelCommand(onApplied);

  async function handleFlatten() {
    await run(() => invoke<string>("flatten_pdf", { path: file.path }));
  }

  return (
    <ToolPanelLayout
      onSubmit={handleFlatten}
      submitLabel="Flatten PDF"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
      progress={progress}
    >
      {/* Description */}
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Merges all form fields and annotations permanently into the page content. Required before
        printing or archiving.
      </p>

      {/* Checklist */}
      <div
        style={{
          border: "1px solid var(--viewer-border)",
          borderRadius: 8,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {CHECKLIST.map((item) => (
          <div key={item} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <IconCheck
              width={14}
              height={14}
              style={{ color: "var(--v-ok-text)", flexShrink: 0 }}
            />
            <span className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>
              {item}
            </span>
          </div>
        ))}
      </div>

      {/* Warning */}
      <div
        style={{
          background: "var(--v-bad-bg)",
          border: "1px solid var(--v-bad-border)",
          borderRadius: 7,
          padding: "8px 10px",
        }}
      >
        <p className="text-xs" style={{ color: "var(--v-bad-text)", lineHeight: 1.5 }}>
          This operation cannot be undone. Save a copy before proceeding.
        </p>
      </div>
    </ToolPanelLayout>
  );
}
