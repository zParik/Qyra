const MONO = "'JetBrains Mono', ui-monospace, monospace";

interface ProgressBarProps {
  current: number;
  total: number;
  message?: string;
}

export function ProgressBar({ current, total, message }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10.5 }}>
        <span style={{ color: "var(--fg2)" }}>{message ?? "Processing…"}</span>
        <span style={{ color: "var(--fg1)" }}>{pct}%</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, overflow: "hidden", background: "var(--line)" }}>
        <div style={{
          height: "100%", borderRadius: 2,
          width: `${pct}%`,
          background: "var(--accent)",
          transition: "width 150ms ease",
        }} />
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, color: "var(--fg2)" }}>
      <svg width={16} height={16} fill="none" viewBox="0 0 16 16"
        style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }}>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
        <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" style={{ color: "var(--accent)" }} />
      </svg>
      <span>{label ?? "Processing…"}</span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
