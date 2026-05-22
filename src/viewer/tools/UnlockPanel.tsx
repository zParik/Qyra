import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { unlockPdf } from "../../lib/tauri";
import { IconEye, IconEyeOff } from "../icons";

interface UnlockPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function UnlockPanel({ file, onApplied }: UnlockPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);

  async function handle() {
    if (!password) return;
    await run(() => unlockPdf(file.path, password));
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Unlock PDF"
      submitDisabled={!password}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>Current password</label>
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handle()}
            className="v-input pr-9"
            placeholder="Enter the PDF password"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="v-icon-btn absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded"
          >
            {show ? <IconEyeOff className="w-4 h-4" /> : <IconEye className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </ToolPanelLayout>
  );
}
