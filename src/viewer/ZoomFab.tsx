import { useIsPhone } from "../hooks/useMediaQuery";

interface Props {
  zoom: number;
  onAdjust: (delta: number) => void;
  onReset: () => void;
}

/**
 * Phone-only floating zoom controls. Anchored bottom-right above the safe-area
 * inset so they clear the Android gesture bar. The desktop header zoom UI is
 * `hidden sm:contents` so this fills the same role on small screens.
 */
export function ZoomFab({ zoom, onAdjust, onReset }: Props) {
  const isPhone = useIsPhone();
  if (!isPhone) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: "max(12px, env(safe-area-inset-right, 0px))",
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        zIndex: 24,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "auto",
      }}
    >
      <FabBtn label="Zoom in" disabled={zoom >= 3.0} onClick={() => onAdjust(0.25)}>
        <svg width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" viewBox="0 0 16 16">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </FabBtn>
      <button
        onClick={onReset}
        aria-label="Reset zoom"
        style={{
          width: 48, height: 32, borderRadius: 16,
          background: "rgba(20, 20, 22, 0.88)",
          color: "var(--viewer-text)",
          border: "1px solid rgba(255,255,255,0.08)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
          backdropFilter: "blur(6px)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {Math.round(zoom * 100)}%
      </button>
      <FabBtn label="Zoom out" disabled={zoom <= 0.25} onClick={() => onAdjust(-0.25)}>
        <svg width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" viewBox="0 0 16 16">
          <path d="M3 8h10" />
        </svg>
      </FabBtn>
    </div>
  );
}

function FabBtn({ label, disabled, onClick, children }: {
  label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 48, height: 48, borderRadius: 24,
        background: "rgba(20, 20, 22, 0.88)",
        color: disabled ? "var(--viewer-text-muted)" : "var(--viewer-text)",
        border: "1px solid rgba(255,255,255,0.08)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(6px)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {children}
    </button>
  );
}
