interface ErrorBannerProps {
  error: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  return (
    <div style={{
      borderRadius: 6, border: "1px solid var(--bad-border)",
      background: "var(--bad-bg)", padding: "12px 14px",
      display: "flex", alignItems: "flex-start", gap: 10,
    }}>
      <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
        style={{ color: "var(--bad-text)", flexShrink: 0, marginTop: 1 }}>
        <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, fontWeight: 600, color: "var(--bad-text)", margin: 0 }}>
          Error
        </p>
        <p style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, color: "var(--bad-text)", opacity: 0.85, margin: "2px 0 0", wordBreak: "break-word" }}>
          {error}
        </p>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: "var(--bad-text)", opacity: 0.7, padding: 2, flexShrink: 0,
            display: "inline-flex", alignItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
        >
          <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
      )}
    </div>
  );
}
