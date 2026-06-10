import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { ProgressBar, Spinner } from "./ProgressBar";
import { FileResult } from "./FileResult";
import { ErrorBanner } from "./ErrorBanner";
import { useIsPhone } from "../hooks/useMediaQuery";

import { MONO } from "../lib/tokens";

interface ToolLayoutProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function ToolLayout({ title, description, children }: ToolLayoutProps) {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
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

  const monoSize = isPhone ? 12 : 10.5;
  const titleSize = isPhone ? 15 : 13;
  const backBtnSize = isPhone ? 44 : 28;
  const iconSize = isPhone ? 18 : 14;
  const headerPadY = isPhone ? 12 : 10;
  const mainPadY = isPhone ? 16 : 24;
  const mainGap = isPhone ? 14 : 16;

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg0)", color: "var(--fg0)" }}>
      {/* Header */}
      <header style={{
        background: "var(--bg1)",
        borderBottom: "1px solid var(--line)",
        paddingTop: `calc(env(safe-area-inset-top, 0px) + ${headerPadY}px)`,
        paddingBottom: headerPadY,
        paddingLeft: 16, paddingRight: 16,
        position: "sticky", top: 0, zIndex: 20,
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <button
            onClick={() => navigate("/")}
            className="btn-secondary"
            style={{ width: backBtnSize, height: backBtnSize, padding: 0, flexShrink: 0 }}
            title="Back to home"
            aria-label="Back to home"
          >
            <svg width={iconSize} height={iconSize} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
              <path d="M10 4L6 8l4 4" />
            </svg>
          </button>

          {/* Breadcrumb — title only on phone, full crumbs on desktop */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
            {!isPhone && (
              <>
                <span style={{ fontFamily: MONO, fontSize: monoSize, color: "var(--fg2)" }}>~/</span>
                <span style={{ fontFamily: MONO, fontSize: monoSize, color: "var(--fg2)" }}>Home</span>
                <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 16" style={{ color: "var(--fg3)", flexShrink: 0 }}>
                  <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
            <span style={{
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: titleSize, fontWeight: 600, color: "var(--fg0)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {title}
            </span>
          </div>

          {description && !isPhone && (
            <>
              <div style={{ width: 1, height: 14, background: "var(--line)" }} />
              <span style={{ fontFamily: MONO, fontSize: monoSize, color: "var(--fg2)" }}>{description}</span>
            </>
          )}
        </div>
      </header>

      {/* Content */}
      <main style={{
        maxWidth: 720, margin: "0 auto",
        padding: `${mainPadY}px 16px`,
        paddingBottom: `calc(${mainPadY}px + env(safe-area-inset-bottom, 0px))`,
        display: "flex", flexDirection: "column", gap: mainGap,
      }}>
        {children}

        {isProcessing && (
          <div style={{
            padding: 16, background: "var(--bg1)",
            border: "1px solid var(--line)", borderRadius: 6,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            {progress ? (
              <ProgressBar current={progress.current} total={progress.total} message={progress.message} />
            ) : (
              <Spinner />
            )}
            {cancelFn && (
              <button
                onClick={cancelFn}
                style={{
                  alignSelf: "flex-end",
                  fontFamily: MONO, fontSize: isPhone ? 13 : 10.5,
                  color: "var(--fg2)", background: "transparent",
                  border: "1px solid var(--line)", borderRadius: 4,
                  padding: isPhone ? "8px 14px" : "3px 10px",
                  minHeight: isPhone ? 44 : undefined,
                  cursor: "pointer",
                }}
              >
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
