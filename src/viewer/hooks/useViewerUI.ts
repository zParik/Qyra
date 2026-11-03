import { useEffect, useState } from "react";

/** Window widths below which a sidebar collapses on its own, leaving room for the page. */
const TOOLS_MIN_WIDTH = 1100;
const STRIP_MIN_WIDTH = 900;

/**
 * Follow a min-width breakpoint: start from it, and reset to it whenever the
 * window crosses it. A manual toggle holds until the next crossing.
 */
function useBreakpointToggle(minWidth: number) {
  const query = `(min-width: ${minWidth}px)`;
  const [on, setOn] = useState<boolean>(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: { matches: boolean }) => setOn(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return [on, setOn] as const;
}

/**
 * Modal/panel open flags for the viewer chrome: sidebar visibility, reading
 * mode and presentation mode.
 */
export function useViewerUI() {
  const [showStrip, setShowStrip] = useBreakpointToggle(STRIP_MIN_WIDTH);
  const [showTools, setShowTools] = useBreakpointToggle(TOOLS_MIN_WIDTH);
  const [readingMode, setReadingMode] = useState<boolean>(false);
  const [showPresentation, setShowPresentation] = useState<boolean>(false);

  return {
    showStrip,
    setShowStrip,
    showTools,
    setShowTools,
    readingMode,
    setReadingMode,
    showPresentation,
    setShowPresentation,
  };
}
