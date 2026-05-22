import { useState } from "react";
import { ViewerTool } from "../ToolSidebar";
import { AnnotationTool } from "../AnnotationToolbar";

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

  // Standard PDF annotation mode
  const [activeAnnotTool, setActiveAnnotTool] = useState<AnnotationTool | null>(null);
  const [annotColor, setAnnotColor] = useState<string>("#ffeb3b");
  const [annotRefreshKey, setAnnotRefreshKey] = useState<number>(0);

  return {
    activeTool,
    setActiveTool,
    selectedPages,
    setSelectedPages,
    splitAfter,
    setSplitAfter,
    activeAnnot,
    setActiveAnnot,
    activeAnnotTool,
    setActiveAnnotTool,
    annotColor,
    setAnnotColor,
    annotRefreshKey,
    setAnnotRefreshKey,
  };
}
