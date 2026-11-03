import { useNavigate } from "react-router-dom";

/** A white peacock, tail fanned: five feathers with their eyes, over the bird. */
export function PeacockMark({ size = 20 }: { size?: number }) {
  // Feather tips on an arc above the body; each carries an eye.
  const tips: [number, number][] = [[3.5, 9], [7, 4.5], [12, 2.5], [17, 4.5], [20.5, 9]];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {tips.map(([x, y], i) => (
        <path key={i} d={`M12 15.5 L${x} ${y}`} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" opacity={0.85} />
      ))}
      {tips.map(([x, y], i) => (
        <g key={`e${i}`}>
          <circle cx={x} cy={y} r={2.1} fill="currentColor" />
          <circle cx={x} cy={y} r={0.75} fill="var(--shell, oklch(0.36 0.09 265))" />
        </g>
      ))}
      <path d="M12 9.5c2.1 0 3.2 2.4 3.2 5.6 0 2.6-1.2 4.8-3.2 7-2-2.2-3.2-4.4-3.2-7 0-3.2 1.1-5.6 3.2-5.6z" fill="currentColor" />
      <circle cx="12" cy="9" r="1.9" fill="currentColor" />
      <path d="M12 7V5.2M10.4 7.3l-.9-1.6M13.6 7.3l.9-1.6" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    </svg>
  );
}

/** The shop sign on the indigo shell. Click returns to the library. */
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
      <PeacockMark size={20} />
      <span>Qyra</span>
    </button>
  );
}
