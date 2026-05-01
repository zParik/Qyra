import type { FallbackProps } from "react-error-boundary";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100vh", gap: 16, padding: 32, background: "var(--bg0)", color: "var(--fg0)",
    }}>
      <svg width={40} height={40} fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
        style={{ color: "var(--bad-text)" }}>
        <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <p style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600, color: "var(--fg0)" }}>
          Something went wrong
        </p>
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg2)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", wordBreak: "break-all" }}>
          {(error instanceof Error ? error.message : null) ?? "Unknown error"}
        </p>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={resetErrorBoundary} className="btn-primary">Try again</button>
        <button onClick={() => { window.location.hash = "/"; resetErrorBoundary(); }} className="btn-secondary">
          Back to Home
        </button>
      </div>
    </div>
  );
}

export function ViewerErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100vh", gap: 16, padding: 32, background: "var(--viewer-bg)", color: "var(--viewer-text)",
    }}>
      <svg width={36} height={36} fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
        style={{ color: "var(--v-bad-text)" }}>
        <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>
          Failed to load document
        </p>
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--viewer-text-sec)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", wordBreak: "break-all" }}>
          {(error instanceof Error ? error.message : null) ?? "Unknown error"}
        </p>
      </div>
      <button onClick={resetErrorBoundary} className="v-btn-primary" style={{ width: "auto", padding: "0 16px" }}>
        Try again
      </button>
    </div>
  );
}
