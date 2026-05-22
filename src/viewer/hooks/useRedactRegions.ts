import { useEffect, useState } from "react";
import { RedactRegion } from "../RedactLayer";

export type RedactMode = "region" | "text";

/**
 * Redaction state — pending regions plus the active selection mode. Regions
 * reset whenever the working file changes.
 */
export function useRedactRegions(viewerPath: string | undefined) {
  const [redactRegions, setRedactRegions] = useState<RedactRegion[]>([]);
  const [redactMode, setRedactMode] = useState<RedactMode>("region");

  // Clear redact regions whenever the working file changes.
  useEffect(() => {
    setRedactRegions([]);
  }, [viewerPath]);

  return {
    redactRegions,
    setRedactRegions,
    redactMode,
    setRedactMode,
  };
}
