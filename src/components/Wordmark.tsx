import { useNavigate } from "react-router-dom";

/**
 * The shop sign: a white peacock eye-feather and the name, set on the indigo
 * shell. Click returns to the library.
 */
export function Wordmark({ onClick }: { onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="wordmark"
      onClick={onClick ?? (() => navigate("/"))}
      title="Qyra — Library"
      aria-label="Qyra, go to library"
    >
      <svg width={18} height={18} viewBox="0 0 20 20" fill="none" aria-hidden="true">
        {/* eye feather: outer vane, inner eye, stem */}
        <path d="M10 1.5c3.6 0 6 3.2 6 7.2 0 3.6-2.6 6.3-6 6.3s-6-2.7-6-6.3c0-4 2.4-7.2 6-7.2z" stroke="currentColor" strokeWidth={1.4} />
        <ellipse cx="10" cy="8.8" rx="2.6" ry="3.2" fill="currentColor" opacity="0.9" />
        <circle cx="10" cy="8.4" r="1" fill="var(--shell, oklch(0.36 0.09 265))" />
        <path d="M10 15v3.5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      </svg>
      <span>Qyra</span>
    </button>
  );
}
