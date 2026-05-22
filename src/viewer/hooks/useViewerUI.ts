import { useState } from "react";

/**
 * Modal/panel open flags for the viewer chrome: sidebar visibility, reading
 * mode, presentation mode, and the discard-changes confirmation overlay.
 */
export function useViewerUI() {
  const [showStrip, setShowStrip] = useState<boolean>(() => window.innerWidth >= 640);
  const [showTools, setShowTools] = useState<boolean>(() => window.innerWidth >= 640);
  const [readingMode, setReadingMode] = useState<boolean>(false);
  const [showPresentation, setShowPresentation] = useState<boolean>(false);
  const [confirmingBack, setConfirmingBack] = useState<boolean>(false);

  return {
    showStrip,
    setShowStrip,
    showTools,
    setShowTools,
    readingMode,
    setReadingMode,
    showPresentation,
    setShowPresentation,
    confirmingBack,
    setConfirmingBack,
  };
}
