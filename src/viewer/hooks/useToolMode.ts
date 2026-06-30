import { useState } from "react";
import { ViewerTool } from "../ToolSidebar";

/**
 * Tool-mode state: which sidebar tool is active, page-selection set for
 * page-scoped tools (remove/split), and annotation-tool sub-state.
 */
export function useToolMode(initialSplitAfter: number) {
  const [activeTool, setActiveTool] = useState<ViewerTool | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [splitAfter, setSplitAfter] = useState<number>(initialSplitAfter);

  // Annotation tool pills (activate draw mode)
  const [activeAnnot, setActiveAnnot] = useState<string | null>(null);

  // Markup color for the text-selection popup (highlight/underline/strikeout).
  const [annotColor, setAnnotColor] = useState<string>("#000000");

  return {
    activeTool,
    setActiveTool,
    selectedPages,
    setSelectedPages,
    splitAfter,
    setSplitAfter,
    activeAnnot,
    setActiveAnnot,
    annotColor,
    setAnnotColor,
  };
}
