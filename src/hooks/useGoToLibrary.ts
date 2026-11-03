import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

/**
 * Show the Library. The shell shows Home only while a Library tab is active,
 * so changing the route alone does nothing when a document tab is in front.
 */
export function useGoToLibrary(): () => void {
  const navigate = useNavigate();
  const showLibrary = useAppStore((s) => s.showLibrary);
  return useCallback(() => {
    showLibrary();
    navigate("/");
  }, [showLibrary, navigate]);
}
