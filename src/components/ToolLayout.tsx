import type { CSSProperties } from "react";
import { useGoToLibrary } from "../hooks/useGoToLibrary";
import { useAppStore } from "../store/useAppStore";
import { ProgressBar, Spinner } from "./ProgressBar";
import { FileResult } from "./FileResult";
import { ErrorBanner } from "./ErrorBanner";
import { IcArrowLeft } from "./Icons";
import { chipStyle, FAMILY, type Family } from "../lib/families";

interface ToolLayoutProps {
  title: string;
  description?: string;
  /** Tool family; colours the chip and thumb index so the page matches its rail entry. */
  family?: Family;
  children: React.ReactNode;
}

/**
 * A standalone tool page: the indigo shell on top, a wood head with the
 * tool's name and family, then a single reading column of work.
 */
export function ToolLayout({ title, description, family = "library", children }: ToolLayoutProps) {
  const goToLibrary = useGoToLibrary();
  // Per-field selectors: only re-render when a field this component reads
  // actually changes. A bare useAppStore() subscribes to the whole store and
  // re-renders on every unrelated write (tab open/close, dirty toggles, etc.).
  const isProcessing = useAppStore((s) => s.isProcessing);
  const progress = useAppStore((s) => s.progress);
  const result = useAppStore((s) => s.result);
  const resultFiles = useAppStore((s) => s.resultFiles);
  const error = useAppStore((s) => s.error);
  const setError = useAppStore((s) => s.setError);
  const cancelFn = useAppStore((s) => s.cancelFn);

  return (
    <div className="tool-shell" style={chipStyle(family) as CSSProperties}>
      <header className="panel-head tool-head">
        <button type="button" className="btn-ghost" onClick={goToLibrary} title="Back to library">
          <IcArrowLeft size={16} />
          Library
        </button>
        <div className="tool-head-text">
          <h1 className="t-title" style={{ margin: 0 }}>{title}</h1>
          {description && <p className="tool-desc">{description}</p>}
        </div>
        <span className="chip">{FAMILY[family].label}</span>
      </header>

      <main className="tool-main">
        {children}

        {isProcessing && (
          <div className="card tool-progress" role="status" aria-live="polite">
            {progress ? (
              <ProgressBar current={progress.current} total={progress.total} message={progress.message} />
            ) : (
              <Spinner />
            )}
            {cancelFn && (
              <button type="button" onClick={cancelFn} className="btn-secondary btn-sm" style={{ alignSelf: "flex-end" }}>
                Cancel
              </button>
            )}
          </div>
        )}

        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        {(result || resultFiles.length > 0) && !isProcessing && (
          <FileResult result={result} resultFiles={resultFiles} />
        )}
      </main>
    </div>
  );
}
