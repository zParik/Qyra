interface ProgressBarProps {
  current: number;
  total: number;
  message?: string;
}

export function ProgressBar({ current, total, message }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={message ?? "Processing"}>
      <div className="progress-row">
        <span>{message ?? "Processing…"}</span>
        <span className="t-num">{pct}%</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <svg width={16} height={16} fill="none" viewBox="0 0 16 16" aria-hidden="true"
        style={{ animation: "spin 0.8s linear infinite", flexShrink: 0, color: "var(--rose)" }}>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
        <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
      <span>{label ?? "Processing…"}</span>
    </div>
  );
}
