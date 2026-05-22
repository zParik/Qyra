import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { ToggleGroup } from "../components/ToggleGroup";
import { rotatePages } from "../../lib/tauri";
import { parsePages } from "../../lib/pageRange";

interface RotatePanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function RotatePanel({ file, onApplied }: RotatePanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [degrees, setDegrees] = useState<"90" | "180" | "270">("90");
  const [applyTo, setApplyTo] = useState<"all" | "specific">("all");
  const [pageList, setPageList] = useState("1");
  const pageCount = file.info?.page_count ?? 0;

  async function handle() {
    const pages = applyTo === "all" ? [] : parsePages(pageList, pageCount);
    await run(() => rotatePages(file.path, pages, Number(degrees) as 90 | 180 | 270));
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Rotate Pages"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <div>
        <label className="text-xs mb-2 block" style={{ color: "var(--viewer-text-muted)" }}>Rotation</label>
        <ToggleGroup
          options={[
            { value: "90",  label: "90°" },
            { value: "180", label: "180°" },
            { value: "270", label: "270°" },
          ]}
          value={degrees}
          onChange={setDegrees}
        />
      </div>

      <div>
        <label className="text-xs mb-2 block" style={{ color: "var(--viewer-text-muted)" }}>Apply to</label>
        <ToggleGroup
          options={[
            { value: "all",      label: "All pages" },
            { value: "specific", label: "Specific" },
          ]}
          value={applyTo}
          onChange={setApplyTo}
        />
        {applyTo === "specific" && (
          <input
            className="v-input mt-2"
            placeholder="e.g. 1, 3-5, 7"
            value={pageList}
            onChange={(e) => setPageList(e.target.value)}
          />
        )}
      </div>
    </ToolPanelLayout>
  );
}
