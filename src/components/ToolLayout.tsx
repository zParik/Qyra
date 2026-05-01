import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { ProgressBar, Spinner } from "./ProgressBar";
import { FileResult } from "./FileResult";
import { ErrorBanner } from "./ErrorBanner";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

interface ToolLayoutProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function ToolLayout({ title, description, children }: ToolLayoutProps) {
  const navigate = useNavigate();
  const { isProcessing, progress, result, resultFiles, error, setError } = useAppStore();

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg0)", color: "var(--fg0)" }}>
      {/* Header */}
      <header style={{
        background: "var(--bg1)",
        borderBottom: "1px solid var(--line)",
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 10px)",
        paddingBottom: "10px",
        paddingLeft: 16, paddingRight: 16,
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => navigate("/")}
            className="btn-secondary"
            style={{ width: 28, height: 28, padding: 0, flexShrink: 0 }}
            title="Back to home"
          >
            <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
              <path d="M10 4L6 8l4 4" />
            </svg>
          </button>

          {/* Breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>~/</span>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>Home</span>
            <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 16" style={{ color: "var(--fg3)", flexShrink: 0 }}>
              <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, fontWeight: 600, color: "var(--fg0)" }}>
              {title}
            </span>
          </div>

          {description && (
            <>
              <div style={{ width: 1, height: 14, background: "var(--line)" }} />
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>{description}</span>
            </>
          )}
        </div>
      </header>

      {/* Content */}
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
        {children}

        {isProcessing && (
          <div style={{
            padding: 16, background: "var(--bg1)",
            border: "1px solid var(--line)", borderRadius: 6,
          }}>
            {progress ? (
              <ProgressBar current={progress.current} total={progress.total} message={progress.message} />
            ) : (
              <Spinner />
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
