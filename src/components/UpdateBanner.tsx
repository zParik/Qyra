import type { UpdaterState } from "../hooks/useUpdater";

interface UpdateBannerProps {
  state: UpdaterState;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ state, onInstall, onRestart, onDismiss }: UpdateBannerProps) {
  if (state.status === "idle" || state.status === "checking") return null;

  if (state.status === "error") {
    return (
      <div style={{
        position: "fixed", bottom: 16, right: 16, zIndex: 9999,
        maxWidth: 300, borderRadius: 8, padding: "8px 12px",
        background: "var(--bg1)", border: "1px solid var(--line)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        display: "flex", alignItems: "center", gap: 10,
        fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12,
        color: "var(--fg2)",
      }}>
        <span>Update check failed</span>
        <button
          onClick={onDismiss}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg3)", padding: 0, lineHeight: 1 }}
        >✕</button>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", bottom: 16, right: 16, zIndex: 9999,
      maxWidth: 340, borderRadius: 8,
      background: "var(--bg1)", border: "1px solid var(--accent-line)",
      boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
      padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "var(--accent)", flexShrink: 0, display: "inline-block",
          }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg0)", fontFamily: "'Inter', system-ui, sans-serif" }}>
            {state.status === "available" && "Update available"}
            {state.status === "downloading" && "Downloading update…"}
            {state.status === "ready" && "Ready to install"}
          </span>
        </div>
        {state.status === "available" && (
          <button
            onClick={onDismiss}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--fg3)", padding: 2, flexShrink: 0,
              display: "inline-flex", alignItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--fg1)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg3)")}
          >
            <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Version info */}
      {state.status === "available" && (
        <p style={{
          margin: 0, fontSize: 11.5, color: "var(--fg2)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}>
          v{state.update.version}
        </p>
      )}

      {/* Progress bar */}
      {state.status === "downloading" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ height: 3, borderRadius: 2, background: "var(--line)", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2,
              width: `${state.progress}%`,
              background: "var(--accent)",
              transition: "width 200ms ease",
            }} />
          </div>
          <span style={{ fontSize: 10.5, color: "var(--fg2)", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
            {state.progress}%
          </span>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {state.status === "available" && (
          <button onClick={onInstall} className="btn-primary" style={{ flex: 1 }}>
            Install update
          </button>
        )}
        {state.status === "ready" && (
          <button onClick={onRestart} className="btn-primary" style={{ flex: 1 }}>
            Restart to apply
          </button>
        )}
      </div>
    </div>
  );
}
