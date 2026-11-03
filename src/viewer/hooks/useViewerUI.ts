import { useState } from "react";

/**
 * Modal/panel open flags for the viewer chrome: sidebar visibility, reading
 * mode and presentation mode.
 */
export function useViewerUI() {
  const [showStrip, setShowStrip] = useState<boolean>(() => window.innerWidth >= 640);
  const [showTools, setShowTools] = useState<boolean>(() => window.innerWidth >= 640);
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
