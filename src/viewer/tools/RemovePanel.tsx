import { useEffect, useRef, useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { LabeledInput } from "../components/LabeledInput";
import { removePages } from "../../lib/tauri";
import { parsePages, formatPages } from "../../lib/pageRange";

interface RemovePanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
  selectedPages: Set<number>;
  onSelectedPagesChange: (pages: Set<number>) => void;
}

export function RemovePanel({ file, onApplied, selectedPages, onSelectedPagesChange }: RemovePanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const pageCount = file.info?.page_count ?? 0;
  const [inputText, setInputText] = useState(() => formatPages([...selectedPages]));
  // Track whether the last change came from the text input so we don't overwrite mid-typing
  const fromInput = useRef(false);

  // Viewer click → update text input
  useEffect(() => {
    if (fromInput.current) {
      fromInput.current = false;
      return;
    }
    setInputText(formatPages([...selectedPages].sort((a, b) => a - b)));
  }, [selectedPages]);

  function handleInputChange(text: string) {
    setInputText(text);
    fromInput.current = true;
    const parsed = parsePages(text, pageCount);
    onSelectedPagesChange(new Set(parsed));
  }

  const pagesToRemove = [...selectedPages].sort((a, b) => a - b);

  async function handle() {
    if (pagesToRemove.length === 0) return;
    await run(() => removePages(file.path, pagesToRemove));
    onSelectedPagesChange(new Set());
    setInputText("");
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel={`Remove ${
        pagesToRemove.length > 0
          ? `${pagesToRemove.length} Page${pagesToRemove.length !== 1 ? "s" : ""}`
          : "Pages"
      }`}
      submitClassName="v-btn-danger"
      submitDisabled={pagesToRemove.length === 0}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      {pageCount > 0 && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>{pageCount} pages total</p>
      )}

      <LabeledInput
        label="Pages to remove"
        value={inputText}
        onChange={handleInputChange}
        placeholder="e.g. 2, 4-6, 9"
        hint="Type page numbers, or click any page in the left strip or center view to select it."
      />
    </ToolPanelLayout>
  );
}
