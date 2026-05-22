import { useState } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { protectPdf } from "../../lib/tauri";
import { IconEye, IconEyeOff } from "../icons";

interface ProtectPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function ProtectPanel({ file, onApplied }: ProtectPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [userPassword, setUserPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [show, setShow] = useState(false);

  async function handle() {
    if (!userPassword) return;
    await run(() => protectPdf(file.path, userPassword, ownerPassword || undefined));
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Protect PDF"
      submitDisabled={!userPassword}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
          User password (required to open)
        </label>
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            value={userPassword}
            onChange={(e) => setUserPassword(e.target.value)}
            className="v-input pr-9"
            placeholder="Enter password"
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

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
          Owner password (optional)
        </label>
        <input
          type={show ? "text" : "password"}
          value={ownerPassword}
          onChange={(e) => setOwnerPassword(e.target.value)}
          className="v-input"
          placeholder="Leave blank to use user password"
        />
      </div>
    </ToolPanelLayout>
  );
}
