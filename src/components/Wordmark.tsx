import { useGoToLibrary } from "../hooks/useGoToLibrary";

/**
 * A white peacock, tail fanned: a scalloped fan of feathers with their eyes,
 * and the bird in front of it, keylined in the shell colour so the body,
 * neck and crest read against the fan even at 20 px.
 */
export function PeacockMark({ size = 20 }: { size?: number }) {
  // Feather lobes on an arc around the body; each lobe carries an eye.
  const lobes: [number, number][] = [[4.6, 13.2], [6.8, 8.4], [12, 6.4], [17.2, 8.4], [19.4, 13.2]];
  const keyline = "var(--shell, oklch(0.36 0.09 265))";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* fan: overlapping lobes make the scalloped silhouette */}
      <g fill="currentColor" opacity={0.92}>
        <circle cx="12" cy="12.2" r="6.4" />
        {lobes.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3.6} />)}
      </g>
      {/* eyes */}
      {lobes.map(([x, y], i) => (
        <g key={`e${i}`}>
          <circle cx={x} cy={y} r={1.45} fill={keyline} />
          <circle cx={x} cy={y} r={0.55} fill="currentColor" />
        </g>
      ))}
      {/* the bird: body, neck, head, crest; keylined so it stands off the fan */}
      <path
        d="M12 8.2c-1.9 0-3 1.6-3 4.2 0 3.4 1.3 6.3 3 9.1 1.7-2.8 3-5.7 3-9.1 0-2.6-1.1-4.2-3-4.2z"
        fill="currentColor" stroke={keyline} strokeWidth={0.9} strokeLinejoin="round"
      />
      <circle cx="12" cy="7.4" r="1.9" fill="currentColor" stroke={keyline} strokeWidth={0.9} />
      <path d="M11.6 6.1l-.8-1.9M12.4 6.1l.8-1.9M12 5.6V3.8" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
      <path d="M11.6 6.1l-.8-1.9M12.4 6.1l.8-1.9M12 5.6V3.8" stroke={keyline} strokeWidth={0.5} strokeLinecap="round" opacity={0.6} />
    </svg>
  );
}

/** The shop sign on the indigo shell. Click returns to the library. */
export function Wordmark({ onClick }: { onClick?: () => void }) {
  const goToLibrary = useGoToLibrary();
  return (
    <button
      type="button"
      className="wordmark"
      onClick={onClick ?? goToLibrary}
      title="Qyra — Library"
      aria-label="Qyra, go to library"
    >
      <PeacockMark size={22} />
      <span>Qyra</span>
    </button>
  );
}
