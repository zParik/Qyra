import { openFile, showInFolder, shareFile } from "../lib/tauri";
import { isAndroid } from "../lib/androidFileUtils";
import { ProgressBar, Spinner } from "../components/ProgressBar";
import type { ProgressData } from "./usePanelCommand";

const revealLabel =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "Reveal in Finder"
    : "Show in Explorer";

interface PanelOutputProps {
  isProcessing: boolean;
  result: string | string[] | null;
  error: string | null;
  onClearError?: () => void;
  progress?: ProgressData | null;
}

export function PanelOutput({
  isProcessing,
  result,
  error,
  onClearError,
  progress,
}: PanelOutputProps) {
  if (isProcessing) {
    return (
      <div className="mt-3 v-panel-processing">
        {progress && progress.total > 1 ? (
          <ProgressBar
            current={progress.current}
            total={progress.total}
            message={progress.message}
          />
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 v-panel-bad space-y-1.5">
        <p className="text-xs font-semibold" style={{ color: "var(--v-bad-text)" }}>
          Error
        </p>
        <p className="text-xs wrap-break-word" style={{ color: "var(--v-bad-text)", opacity: 0.9 }}>
          {error}
        </p>
        {onClearError && (
          <button
            onClick={onClearError}
            className="text-xs underline"
            style={{ color: "var(--v-bad-text)" }}
          >
            Dismiss
          </button>
        )}
      </div>
    );
  }

  if (!result) return null;

  const paths = typeof result === "string" ? [result] : result;
  const mainPath = paths[0];

  return (
    <div className="mt-3 v-panel-ok space-y-2">
      <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-xs font-semibold">
          Done{paths.length > 1 ? ` — ${paths.length} files saved` : ""}
        </span>
      </div>

      {/* Full path for compliance / verifiability */}
      <p
        className="text-xs break-all leading-relaxed"
        style={{ color: "var(--viewer-text-muted)" }}
        title={mainPath}
      >
        {mainPath}
      </p>

      <div className="flex gap-1.5 flex-wrap">
        {isAndroid() ? (
          <button
            onClick={() => shareFile(mainPath).catch(() => {})}
            className="v-output-btn text-xs px-2 py-1 rounded"
          >
            Save to Downloads
          </button>
        ) : (
          <>
            <button
              onClick={() => openFile(mainPath).catch(() => {})}
              className="v-output-btn text-xs px-2 py-1 rounded"
            >
              Open
            </button>
            <button
              onClick={() => showInFolder(mainPath).catch(() => {})}
              className="v-output-btn text-xs px-2 py-1 rounded"
            >
              {revealLabel}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
