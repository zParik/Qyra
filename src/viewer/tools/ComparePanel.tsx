import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { LoadedFile } from "../../store/useAppStore";
import { CompareView } from "../CompareView";
import { StatusBox } from "../components/StatusBox";

interface Props {
  file: LoadedFile;
}

export function ComparePanel({ file }: Props) {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [open_, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    try {
      const result = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof result === "string") {
        setPickedPath(result);
      } else if (result && typeof result === "object" && "path" in result) {
        setPickedPath((result as { path: string }).path);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function startCompare() {
    if (!pickedPath) return;
    setOpen(true);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Open another PDF side-by-side with the current one. Use ◀ ▶ or arrow keys to step through both
        documents in lock-step.
      </p>

      <div className="space-y-2">
        <button
          className="v-btn-secondary w-full"
          onClick={pickFile}
        >
          {pickedPath ? "Change second PDF…" : "Pick second PDF…"}
        </button>

        {pickedPath && (
          <p
            className="text-xs wrap-break-word"
            style={{ color: "var(--viewer-text-sec)", fontFamily: "monospace", wordBreak: "break-all" }}
          >
            B: {pickedPath}
          </p>
        )}
      </div>

      <button
        className="v-btn-primary w-full"
        disabled={!pickedPath}
        onClick={startCompare}
      >
        Compare side-by-side
      </button>

      {error && (
        <StatusBox status="error" message={error} marginTopClass="mt-2" />
      )}

      {open_ && pickedPath && (
        <CompareView
          pathA={file.path}
          pathB={pickedPath}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
