import { useEffect, useRef, useState } from "react";
import { useIsPhone } from "../hooks/useMediaQuery";

interface Props {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  currentPage: number;
  pageCount: number;
}

/**
 * Phone-only floating page indicator. Fades in on scroll, fades out 900ms
 * after the user stops scrolling. Anchored to the right edge so it sits
 * roughly where a native scrollbar thumb would.
 */
export function ScrollPageIndicator({ scrollContainerRef, currentPage, pageCount }: Props) {
  const isPhone = useIsPhone();
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isPhone) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const onScroll = () => {
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), 900);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isPhone, scrollContainerRef]);

  if (!isPhone || pageCount <= 1) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        right: "max(12px, env(safe-area-inset-right, 0px))",
        top: "50%",
        transform: `translateY(-50%) translateX(${visible ? 0 : 12}px)`,
        opacity: visible ? 1 : 0,
        transition: "opacity 180ms ease-out, transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        pointerEvents: "none",
        zIndex: 25,
        padding: "8px 12px",
        borderRadius: 999,
        background: "rgba(20, 20, 22, 0.88)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        color: "var(--viewer-text)",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.04em",
        backdropFilter: "blur(6px)",
        whiteSpace: "nowrap",
      }}
    >
      {currentPage}
      <span style={{ color: "var(--viewer-text-muted)", margin: "0 4px" }}>/</span>
      {pageCount}
    </div>
  );
}
