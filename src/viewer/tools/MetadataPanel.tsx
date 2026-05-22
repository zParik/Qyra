import { useState, useEffect } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { LabeledInput } from "../components/LabeledInput";
import { setMetadata, getMetadata, PdfMetadata } from "../../lib/tauri";

const FIELDS: { key: keyof PdfMetadata; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "subject", label: "Subject" },
  { key: "keywords", label: "Keywords" },
  { key: "creator", label: "Creator" },
];

interface MetadataPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function MetadataPanel({ file, onApplied }: MetadataPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [meta, setMeta] = useState<PdfMetadata>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setMeta({});
    getMetadata(file.path)
      .then((m) => { setMeta(m); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [file.path]);

  async function handle() {
    await run(() => setMetadata(file.path, meta));
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Save Metadata"
      submitDisabled={!loaded}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      {!loaded && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>Loading metadata...</p>
      )}

      {loaded && FIELDS.map(({ key, label }) => (
        <LabeledInput
          key={key}
          label={label}
          value={meta[key] ?? ""}
          onChange={(v) => setMeta((m) => ({ ...m, [key]: v || undefined }))}
          placeholder={label}
        />
      ))}
    </ToolPanelLayout>
  );
}
