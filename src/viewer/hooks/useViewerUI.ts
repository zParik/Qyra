import { useEffect, useRef, useState } from "react";

/** Window widths below which a sidebar collapses on its own, leaving room for the page. */
const TOOLS_MIN_WIDTH = 1100;
const STRIP_MIN_WIDTH = 900;

/**
 * Follow a min-width breakpoint: start from it, and reset to it whenever the
 * window crosses it. `compact` (a split pane) holds it closed. A manual toggle holds until the next crossing.
 */
function useBreakpointToggle(minWidth: number, compact: boolean) {
  const query = `(min-width: ${minWidth}px)`;
  const [on, setOn] = useState<boolean>(() => !compact && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: { matches: boolean }) => setOn(!compact && e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query, compact]);
  // Splitting or unsplitting the pane is a crossing too.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setOn(!compact && window.matchMedia(query).matches);
  }, [compact, query]);
  return [on, setOn] as const;
}

/**
 * Modal/panel open flags for the viewer chrome: sidebar visibility, reading
 * mode and presentation mode.
 */
export function useViewerUI(split = false) {
  // A split pane is half a window: both sidebars start closed there.
  const [showStrip, setShowStrip] = useBreakpointToggle(STRIP_MIN_WIDTH, split);
  const [showTools, setShowTools] = useBreakpointToggle(TOOLS_MIN_WIDTH, split);
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
