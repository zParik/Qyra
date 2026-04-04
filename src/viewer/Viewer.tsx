import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore, LoadedFile } from "../store/useAppStore";
import { useNotesStore, PageTemplate, VirtualPage } from "../store/useNotesStore";

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];
import { usePageThumbnails, usePageThumbnailsEager } from "../hooks/usePageThumbnails";
import { PageStrip } from "./PageStrip";
import { ToolSidebar, ViewerTool } from "./ToolSidebar";
import { getPdfInfo, copyFile, showSaveDialog, bakeAnnotations } from "../lib/tauri";
import { triggerPrint } from "./tools/PrintPanel";
import { evictPathFromThumbnailCache } from "../hooks/usePageThumbnails";
import { DrawingCanvas } from "./DrawingCanvas";
import { VirtualPageBackground } from "./VirtualPageBackground";
import { DrawToolbar } from "./tools/DrawToolbar";
import { TextLayer } from "./TextLayer";
import { FindBar } from "./FindBar";
import { loadDocument } from "../hooks/usePageThumbnails";
import { useVisiblePages } from "../hooks/useVisiblePages";

export default function Viewer() {
  const navigate = useNavigate();
  const {
    viewerFile, setViewerFile,
    undoViewerFile, setUndoViewerFile,
    originalViewerPath, setOriginalViewerPath,
    isViewerDirty, setIsViewerDirty,
  } = useAppStore();
  const [currentPage, setCurrentPage] = useState(1);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingBack, setConfirmingBack] = useState(false);
  const [activeTool, setActiveTool] = useState<ViewerTool | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [splitAfter, setSplitAfter] = useState(() =>
    Math.max(1, Math.floor((viewerFile?.info?.page_count ?? 2) / 2))
  );
  const undoStroke = useNotesStore((s) => s.undoStroke);
  const virtualPages = useNotesStore((s) => s.virtualPages[viewerFile?.path ?? ""] ?? EMPTY_VIRTUAL_PAGES);
  const addVirtualPage = useNotesStore((s) => s.addVirtualPage);

  // "Add page" inline UI: which insertion point is open (afterRealPage value)
  const [addPageAt, setAddPageAt] = useState<number | null>(null);

  const [zoom, setZoom] = useState(1.0);
  const [showStrip, setShowStrip] = useState(false);
  const [showTools, setShowTools] = useState(false);

  // Find-in-document
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<{ page: number }[]>([]);
  const [findCurrentIdx, setFindCurrentIdx] = useState(0);

  // Go-to-page input
  const [editingPage, setEditingPage] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");

  function adjustZoom(delta: number) {
    setZoom((prev) => {
      const next = Math.round((prev + delta) * 100) / 100;
      return Math.min(3.0, Math.max(0.25, next));
    });
  }

  function handleToolChange(tool: ViewerTool | null) {
    setActiveTool(tool);
    if (tool !== "remove") setSelectedPages(new Set());
  }

  function handlePageToggle(page: number) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  }

  const pageCount = viewerFile?.info?.page_count ?? 0;

  // Merged ordered list of real PDF pages + inserted virtual pages
  type PageSlot =
    | { type: 'pdf'; pdfPage: number; slotId: string }
    | { type: 'virtual'; vp: VirtualPage; slotId: string };

  const pageSlots = useMemo<PageSlot[]>(() => {
    const slots: PageSlot[] = [];
    const clampedVPs = virtualPages.map((vp) => ({
      ...vp,
      afterRealPage: Math.min(vp.afterRealPage, pageCount),
    }));
    clampedVPs.filter((vp) => vp.afterRealPage === 0)
      .forEach((vp) => slots.push({ type: 'virtual', vp, slotId: vp.id }));
    for (let p = 1; p <= pageCount; p++) {
      slots.push({ type: 'pdf', pdfPage: p, slotId: `pdf-${p}` });
      clampedVPs.filter((vp) => vp.afterRealPage === p)
        .forEach((vp) => slots.push({ type: 'virtual', vp, slotId: vp.id }));
    }
    return slots;
  }, [virtualPages, pageCount]);

  // --- Visibility tracking for lazy rendering ---
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { visibleIds, observe, unobserve: _unobserve } = useVisiblePages(scrollContainerRef, 1200);

  // Derive the set of visible PDF page numbers from visible slot IDs
  const visiblePageNums = useMemo(() => {
    const nums = new Set<number>();
    for (const id of visibleIds) {
      if (id.startsWith("pdf-")) {
        const n = parseInt(id.slice(4), 10);
        if (!isNaN(n)) nums.add(n);
      }
    }
    return nums;
  }, [visibleIds]);

  const stripThumbnails = usePageThumbnailsEager(viewerFile?.path ?? null, pageCount, 0.3);
  const centerThumbnails = usePageThumbnails(viewerFile?.path ?? null, pageCount, 2.0, visiblePageNums);

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const pageCallbacksRef = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  
  // Stable ref-callback factory to prevent infinite detached/attached DOM polling
  const getPageRef = useCallback((slotId: string) => {
    if (!pageCallbacksRef.current[slotId]) {
      pageCallbacksRef.current[slotId] = (el: HTMLDivElement | null) => {
        if (slotId.startsWith("pdf-")) {
          const pageNum = parseInt(slotId.slice(4), 10);
          if (!isNaN(pageNum)) pageRefs.current[pageNum] = el;
        }
        // Observe directly if observer is ready
        if (el) observe(el, slotId);
      };
    }
    return pageCallbacksRef.current[slotId];
  }, [observe]);

  // Fallback: If observer wasn't ready when refs first attached, observe them now
  useEffect(() => {
    for (let page = 1; page <= pageCount; page++) {
      const el = pageRefs.current[page];
      if (el) observe(el, `pdf-${page}`);
    }
  }, [observe, pageCount]);

  useEffect(() => {
    if (!viewerFile) navigate("/");
  }, [viewerFile]);

  useEffect(() => {
    if (viewerFile && !isViewerDirty) {
      setOriginalViewerPath(viewerFile.path);
    }
  }, []);

  // Ctrl+wheel / pinch-to-zoom (non-passive, attached to window so WebView2 native zoom is blocked)
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const container = scrollContainerRef.current;
        const containerWidth = container ? container.clientWidth : window.innerWidth;
        // fitZoom = zoom at which page exactly fills container (accounting for 32px horizontal padding)
        const fitZoom = (containerWidth - 32) / 768;
        setZoom((prev) => {
          const factor = Math.pow(0.999, e.deltaY);
          const next = Math.min(3.0, Math.max(0.25, prev * factor));
          // Magnet: snap to fit-width when within 4% of it
          if (Math.abs(next - fitZoom) < fitZoom * 0.04) return fitZoom;
          return next;
        });
      }
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // Auto-fit zoom on small screens so the PDF isn't wider than the viewport
  useEffect(() => {
    if (window.innerWidth >= 640) return;
    const fitZoom = (window.innerWidth - 32) / 768;
    setZoom(Math.max(0.25, Math.min(1.0, fitZoom)));
  }, []);

  // Search all pages for find query
  useEffect(() => {
    if (!findQuery.trim() || !viewerFile || pageCount === 0) {
      setFindMatches([]);
      setFindCurrentIdx(0);
      return;
    }
    let cancelled = false;
    const q = findQuery.trim().toLowerCase();

    async function search() {
      try {
        const doc = await loadDocument(viewerFile!.path);
        const matches: { page: number }[] = [];
        for (let p = 1; p <= pageCount; p++) {
          if (cancelled) return;
          const page = await doc.getPage(p);
          const tc = await page.getTextContent();
          const text = (tc.items as { str?: string }[])
            .map((item) => item.str ?? "")
            .join("");
          if (text.toLowerCase().includes(q)) {
            matches.push({ page: p });
          }
        }
        if (!cancelled) {
          setFindMatches(matches);
          setFindCurrentIdx(0);
        }
      } catch { /* ignore */ }
    }

    search();
    return () => { cancelled = true; };
  }, [findQuery, viewerFile?.path, pageCount]);

  // Navigate to current find match page
  useEffect(() => {
    if (findMatches.length === 0) return;
    const match = findMatches[findCurrentIdx];
    if (match) scrollToPage(match.page);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findCurrentIdx, findMatches]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        setFindOpen(false);
        setFindQuery("");
        return;
      }

      if (e.key === "Escape" && confirmingBack) {
        e.preventDefault();
        setConfirmingBack(false);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "f") {
        e.preventDefault();
        setFindOpen(true);
        return;
      }

      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        adjustZoom(0.25);
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        adjustZoom(-0.25);
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        setZoom(1.0);
        return;
      }

      if (mod && e.key === "p") {
        e.preventDefault();
        if (viewerFile) triggerPrint(viewerFile.path);
        return;
      }
      if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        // In draw mode, Ctrl+Z undoes the last stroke
        if (activeTool === "draw" && viewerFile) {
          undoStroke(viewerFile.path);
          return;
        }
        if (undoViewerFile) {
          setViewerFile(undoViewerFile);
          setUndoViewerFile(null);
          setIsViewerDirty(undoViewerFile.path !== (originalViewerPath ?? ""));
          setCurrentPage(1);
        }
        return;
      }
      if (mod && !e.shiftKey && e.key === "s") {
        if (isViewerDirty) { e.preventDefault(); handleSave(); }
        return;
      }
      if (mod && e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); handleSaveAs();
        return;
      }
      if (!mod && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
        if (currentPage < pageCount) scrollToPage(currentPage + 1);
        return;
      }
      if (!mod && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
        if (currentPage > 1) scrollToPage(currentPage - 1);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isViewerDirty, confirmingBack, findOpen, currentPage, pageCount, viewerFile, undoViewerFile, originalViewerPath, zoom, activeTool, undoStroke]);

  if (!viewerFile) return null;

  const displayName = isViewerDirty && originalViewerPath
    ? originalViewerPath.split(/[\\/]/).pop() ?? originalViewerPath
    : viewerFile.name;

  function handleBack() {
    if (isViewerDirty) {
      setConfirmingBack(true);
      return;
    }
    doBack();
  }

  function doBack() {
    setViewerFile(null);
    setUndoViewerFile(null);
    setOriginalViewerPath(null);
    setIsViewerDirty(false);
    navigate("/");
  }

  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let closest = 1;
    let closestDist = Infinity;
    for (let page = 1; page <= pageCount; page++) {
      const el = pageRefs.current[page];
      if (!el) continue;
      const dist = Math.abs(el.getBoundingClientRect().top - containerTop);
      if (dist < closestDist) { closestDist = dist; closest = page; }
    }
    setCurrentPage(closest);
  }

  function scrollToPage(page: number) {
    setCurrentPage(page);
    const container = scrollContainerRef.current;
    const el = pageRefs.current[page];
    if (container && el) {
      const gbcContainer = container.getBoundingClientRect();
      const gbcEl = el.getBoundingClientRect();
      container.scrollTop += gbcEl.top - gbcContainer.top;
    } else {
      pageRefs.current[page]?.scrollIntoView({ behavior: "auto", block: "start" });
    }
  }

  async function handleOpenFile(path: string) {
    try {
      const info = await getPdfInfo(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      setViewerFile({ path, name, info } as LoadedFile);
      setCurrentPage(1);
    } catch {
      const name = path.split(/[\\/]/).pop() ?? path;
      setViewerFile({ path, name });
      setCurrentPage(1);
    }
  }

  async function handleApplied(path: string) {
    setUndoViewerFile(viewerFile); // snapshot for Ctrl+Z
    await handleOpenFile(path);
    setIsViewerDirty(true);
  }

  function friendlySaveError(e: unknown): string {
    const msg = String(e).toLowerCase();
    if (msg.includes("permission") || msg.includes("access is denied") || msg.includes("code: 5"))
      return "Permission denied — check that the file isn't open in another app and you have write access.";
    if (msg.includes("disk full") || msg.includes("no space") || msg.includes("code: 28") || msg.includes("code: 112"))
      return "Not enough disk space to save.";
    if (msg.includes("file is locked") || msg.includes("sharing violation") || msg.includes("code: 32"))
      return "The file is locked by another application — close it and try again.";
    if (msg.includes("not found") || msg.includes("code: 2") || msg.includes("code: 3"))
      return "The destination folder no longer exists — try Save As to choose a new location.";
    return "Couldn't save the file — check the destination and try again.";
  }

  async function handleSave() {
    if (!viewerFile || !originalViewerPath) return;
    setSaveError(null);
    try {
      await copyFile(viewerFile.path, originalViewerPath);
      evictPathFromThumbnailCache(originalViewerPath);
      await handleOpenFile(originalViewerPath);
      setIsViewerDirty(false);
    } catch (e) {
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAs() {
    if (!viewerFile) return;
    setSaveError(null);
    const chosenPath = await showSaveDialog(viewerFile.path);
    if (!chosenPath) return;
    try {
      await copyFile(viewerFile.path, chosenPath);
      evictPathFromThumbnailCache(chosenPath);
      await handleOpenFile(chosenPath);
      setOriginalViewerPath(chosenPath);
      setIsViewerDirty(false);
    } catch (e) {
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAnnotations() {
    if (!viewerFile || !originalViewerPath) return;
    setSaveError(null);

    const allStrokes = useNotesStore.getState().strokes[viewerFile.path] ?? [];
    const byPage = new Map<number, typeof allStrokes>();
    for (const s of allStrokes) {
      if (!s.pageSlotId.startsWith('pdf-')) continue;
      const page = parseInt(s.pageSlotId.slice(4), 10);
      if (isNaN(page)) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(s);
    }

    try {
      let savePath = viewerFile.path;
      if (byPage.size > 0) {
        const annotations = Array.from(byPage.entries()).map(([page, strokes]) => ({
          page,
          strokes: strokes.map(s => ({
            tool: s.tool,
            color: s.color,
            thickness: s.baseThickness,
            points: s.points.map(([x, y]) => [x, y] as [number, number]),
          })),
        }));
        savePath = await bakeAnnotations(viewerFile.path, annotations);
      }
      await copyFile(savePath, originalViewerPath);
      evictPathFromThumbnailCache(originalViewerPath);
      // Don't clear strokes — they stay as overlay while thumbnails reload in the background
      setViewerFile({ ...viewerFile, path: originalViewerPath });
      setIsViewerDirty(false);
    } catch (e) {
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAsAnnotations() {
    if (!viewerFile) return;
    setSaveError(null);
    const chosenPath = await showSaveDialog(viewerFile.path);
    if (!chosenPath) return;

    const allStrokes = useNotesStore.getState().strokes[viewerFile.path] ?? [];
    const byPage = new Map<number, typeof allStrokes>();
    for (const s of allStrokes) {
      if (!s.pageSlotId.startsWith('pdf-')) continue;
      const page = parseInt(s.pageSlotId.slice(4), 10);
      if (isNaN(page)) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(s);
    }

    try {
      let savePath = viewerFile.path;
      if (byPage.size > 0) {
        const annotations = Array.from(byPage.entries()).map(([page, strokes]) => ({
          page,
          strokes: strokes.map(s => ({
            tool: s.tool,
            color: s.color,
            thickness: s.baseThickness,
            points: s.points.map(([x, y]) => [x, y] as [number, number]),
          })),
        }));
        savePath = await bakeAnnotations(viewerFile.path, annotations);
      }
      await copyFile(savePath, chosenPath);
      evictPathFromThumbnailCache(chosenPath);
      setViewerFile({ ...viewerFile, path: chosenPath });
      setOriginalViewerPath(chosenPath);
      setIsViewerDirty(false);
    } catch (e) {
      setSaveError(friendlySaveError(e));
    }
  }

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: "var(--viewer-bg)", color: "var(--viewer-text)" }}
    >
      {/* Header */}
      <header
        className="flex items-center gap-2 px-3 shrink-0"
        style={{
          background: "var(--viewer-surface)",
          borderBottom: "1px solid var(--viewer-border)",
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          onClick={handleBack}
          className="v-icon-btn p-2 sm:p-1.5 rounded-lg shrink-0"
          title="Back to home"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* File info */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <svg className="w-4 h-4 shrink-0" style={{ color: "var(--brand)" }} fill="currentColor" viewBox="0 0 24 24">
            <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <h1
            className="font-semibold text-sm truncate"
            style={{ color: "var(--viewer-text)" }}
          >
            {displayName}
          </h1>
          {isViewerDirty && (
            <span
              className="text-xs shrink-0"
              style={{ color: "oklch(65% 0.16 65)" }}
              title="Unsaved changes"
            >
              ●
            </span>
          )}
          {viewerFile.info && (
            <span className="text-xs shrink-0 hidden sm:inline" style={{ color: "var(--viewer-text-muted)" }}>
              {viewerFile.info.page_count} {viewerFile.info.page_count !== 1 ? "pages" : "page"}
            </span>
          )}
        </div>

        {/* Page indicator / go-to-page input */}
        {pageCount > 0 && (
          editingPage ? (
            <input
              type="number"
              min={1}
              max={pageCount}
              value={pageInputValue}
              autoFocus
              className="text-xs tabular-nums rounded px-1 py-0.5 hidden sm:block"
              style={{
                width: "5rem",
                background: "var(--viewer-elevated)",
                border: "1px solid var(--viewer-border)",
                color: "var(--viewer-text)",
                caretColor: "var(--viewer-text)",
                textAlign: "center",
              }}
              onChange={(e) => setPageInputValue(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  const p = parseInt(pageInputValue, 10);
                  if (p >= 1 && p <= pageCount) scrollToPage(p);
                  setEditingPage(false);
                } else if (e.key === "Escape") {
                  setEditingPage(false);
                }
              }}
              onBlur={() => {
                const p = parseInt(pageInputValue, 10);
                if (p >= 1 && p <= pageCount) scrollToPage(p);
                setEditingPage(false);
              }}
            />
          ) : (
            <button
              onClick={() => {
                setPageInputValue(String(currentPage));
                setEditingPage(true);
              }}
              className="text-xs shrink-0 tabular-nums hidden sm:inline rounded px-1 py-0.5"
              style={{ color: "var(--viewer-text-muted)" }}
              title="Go to page — click to jump"
            >
              {currentPage} / {pageCount}
            </button>
          )
        )}

        {/* Zoom controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => adjustZoom(-0.25)}
            className="v-icon-btn p-1.5 sm:p-1 rounded"
            title="Zoom out (Ctrl+-)"
            disabled={zoom <= 0.25}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <button
            onClick={() => setZoom(1.0)}
            className="text-xs tabular-nums px-1.5 py-0.5 rounded"
            style={{ color: "var(--viewer-text-muted)", minWidth: "3rem" }}
            title="Reset zoom (Ctrl+0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => adjustZoom(0.25)}
            className="v-icon-btn p-1.5 sm:p-1 rounded"
            title="Zoom in (Ctrl+=)"
            disabled={zoom >= 3.0}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        {/* Undo — shown when a panel operation can be reversed */}
        {undoViewerFile && (
          <button
            onClick={() => {
              setViewerFile(undoViewerFile);
              setUndoViewerFile(null);
              setIsViewerDirty(undoViewerFile.path !== (originalViewerPath ?? ""));
              setCurrentPage(1);
            }}
            className="v-btn-secondary-sm text-xs px-2 sm:px-2.5 py-2 sm:py-1.5 rounded-lg flex items-center gap-1 sm:gap-1.5 shrink-0"
            title="Undo last operation (Ctrl+Z)"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="hidden sm:inline">Undo</span>
          </button>
        )}

        {/* Save actions — only when dirty */}
        {isViewerDirty && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleSave}
              className="v-btn-primary-sm text-xs px-3 py-2 sm:py-1.5 rounded-lg font-medium flex items-center gap-1.5"
              title="Save (Ctrl+S)"
            >
              Save
              <kbd className="text-xs opacity-60 hidden sm:inline" style={{ fontFamily: "inherit" }}>Ctrl+S</kbd>
            </button>
            <button
              onClick={handleSaveAs}
              className="v-btn-secondary-sm text-xs px-3 py-2 sm:py-1.5 rounded-lg hidden sm:flex items-center gap-1.5"
              title="Save As (Ctrl+Shift+S)"
            >
              Save As
              <kbd className="text-xs opacity-50" style={{ fontFamily: "inherit" }}>Ctrl+Shift+S</kbd>
            </button>
          </div>
        )}

        {/* Mobile-only: page strip and tools drawer toggles */}
        <button
          onClick={() => { setShowStrip(s => !s); setShowTools(false); }}
          className="v-icon-btn p-2 rounded-lg sm:hidden shrink-0"
          title="Toggle page strip"
          style={showStrip ? { color: "var(--action)" } : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
        </button>
        <button
          onClick={() => { setShowTools(t => !t); setShowStrip(false); }}
          className="v-icon-btn p-2 rounded-lg sm:hidden shrink-0"
          title="Toggle tools"
          style={showTools ? { color: "var(--action)" } : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        </button>
      </header>

      {/* Discard-changes confirmation overlay */}
      {confirmingBack && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "color-mix(in oklch, var(--viewer-bg) 70%, transparent)" }}
          onClick={() => setConfirmingBack(false)}
        >
          <div
            className="flex flex-col gap-4 rounded-xl px-6 py-5 w-80 mx-4"
            style={{
              background: "var(--viewer-elevated)",
              border: "1px solid var(--viewer-border)",
              boxShadow: "0 8px 32px color-mix(in oklch, oklch(0% 0 0) 40%, transparent)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--viewer-text)" }}>
                Discard unsaved changes?
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--viewer-text-sec)" }}>
                Your changes will be lost. This cannot be undone.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmingBack(false)}
                className="v-btn-secondary-sm text-xs px-4 py-1.5 rounded-lg"
                autoFocus
              >
                Cancel
              </button>
              <button
                onClick={doBack}
                className="v-btn-danger text-xs px-4 py-1.5 rounded-lg"
                style={{ display: "inline-flex", width: "auto" }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save error banner */}
      {saveError && (
        <div
          className="px-4 py-2 text-xs flex items-center justify-between shrink-0"
          style={{
            background: "var(--v-bad-bg)",
            borderBottom: "1px solid var(--v-bad-border)",
            color: "var(--v-bad-text)",
          }}
        >
          <span>Save failed: {saveError}</span>
          <button
            onClick={() => setSaveError(null)}
            className="underline ml-3"
            style={{ color: "var(--v-bad-text)" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Find bar — shown when Ctrl+F is pressed */}
      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={(q) => { setFindQuery(q); setFindCurrentIdx(0); }}
          matchCount={findMatches.length}
          currentMatch={findMatches.length === 0 ? 0 : findCurrentIdx + 1}
          onNext={() => setFindCurrentIdx((i) => (i + 1) % Math.max(1, findMatches.length))}
          onPrev={() => setFindCurrentIdx((i) => (i - 1 + Math.max(1, findMatches.length)) % Math.max(1, findMatches.length))}
          onClose={() => { setFindOpen(false); setFindQuery(""); }}
        />
      )}

      {/* Draw toolbar — shown when draw mode is active */}
      {activeTool === "draw" && (
        <DrawToolbar
          onExitDraw={() => handleToolChange(null)}
          onSave={handleSaveAnnotations}
          onSaveAs={handleSaveAsAnnotations}
          currentPage={currentPage}
          pageCount={pageCount}
          onApplied={handleApplied}
          filePath={viewerFile.path}
        />
      )}

      {/* Three-panel body */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left: page strip — always visible on desktop, slide-in drawer on mobile */}
        <div
          className={`h-full shrink-0 flex-col ${
            showStrip
              ? "flex absolute inset-y-0 left-0 z-20 sm:static sm:flex"
              : "hidden sm:flex"
          }`}
        >
          <PageStrip
            pageCount={pageCount}
            thumbnails={stripThumbnails}
            currentPage={currentPage}
            onPageSelect={(page) => { scrollToPage(page); setShowStrip(false); }}
            selectionMode={activeTool === "remove"}
            selectedPages={selectedPages}
            onPageToggle={handlePageToggle}
            splitAfter={activeTool === "split" ? splitAfter : undefined}
            onSplitAfterChange={activeTool === "split" ? setSplitAfter : undefined}
          />
        </div>

        {/* Center: continuous scroll canvas */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto"
          style={{ background: "var(--viewer-canvas)" }}
          onScroll={handleScroll}
        >
          <div className="flex flex-col items-center py-4 px-4 gap-0 sm:py-8 sm:px-8">

            {/* Inline "Add page" template picker */}
            {addPageAt !== null && activeTool === "draw" && (
              <div
                className="fixed inset-0 z-30 flex items-center justify-center"
                style={{ background: "rgba(0,0,0,0.3)" }}
                onClick={() => setAddPageAt(null)}
              >
                <div
                  className="flex flex-col gap-3 rounded-xl px-5 py-4 w-72"
                  style={{
                    background: "var(--viewer-elevated)",
                    border: "1px solid var(--viewer-border)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-sm font-semibold" style={{ color: "var(--viewer-text)" }}>
                    Insert page {addPageAt === 0 ? "before start" : `after page ${addPageAt}`}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { id: 'blank',  label: 'Blank',  preview: '□' },
                      { id: 'ruled',  label: 'Ruled',  preview: '≡' },
                      { id: 'grid',   label: 'Grid',   preview: '⊞' },
                      { id: 'dotted', label: 'Dotted', preview: '⠿' },
                    ] as { id: PageTemplate; label: string; preview: string }[]).map((tmpl) => (
                      <button
                        key={tmpl.id}
                        onClick={() => {
                          const vp: VirtualPage = {
                            id: crypto.randomUUID(),
                            template: tmpl.id,
                            afterRealPage: addPageAt,
                          };
                          addVirtualPage(viewerFile.path, vp);
                          setAddPageAt(null);
                        }}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm"
                        style={{
                          background: "var(--viewer-surface)",
                          border: "1px solid var(--viewer-border)",
                          color: "var(--viewer-text)",
                        }}
                      >
                        <span className="text-lg leading-none">{tmpl.preview}</span>
                        <span>{tmpl.label}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setAddPageAt(null)}
                    className="text-xs text-center mt-1"
                    style={{ color: "var(--viewer-text-muted)" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Add-page bar before all pages */}
            {activeTool === "draw" && (
              <AddPageBar onAdd={() => setAddPageAt(0)} />
            )}

            {pageSlots.map((slot) => {
              const isVisible = visibleIds.has(slot.slotId);

              if (slot.type === 'pdf') {
                const page = slot.pdfPage;
                const isSelected = activeTool === "remove" && selectedPages.has(page);
                return (
                  <React.Fragment key={slot.slotId}>
                    <div
                      ref={getPageRef(slot.slotId)}
                      className="relative my-4 sm:my-8"
                      style={{
                        width: `min(${Math.round(zoom * 768)}px, 100%)`,
                        cursor: activeTool === "remove" ? "pointer" : undefined,
                      }}
                      onClick={activeTool === "remove" ? () => handlePageToggle(page) : undefined}
                    >
                      {/* Only render heavy content (image, text layer, drawing canvas) for visible pages */}
                      {isVisible || centerThumbnails[page] ? (
                        <>
                          {centerThumbnails[page] ? (
                            <img
                              src={centerThumbnails[page]}
                              alt={`Page ${page}`}
                              className="w-full rounded shadow-2xl block"
                              draggable={false}
                              style={isSelected ? { outline: "3px solid #ef4444", borderRadius: "0.5rem" } : undefined}
                            />
                          ) : (
                            <div
                              className="rounded flex flex-col items-center justify-center gap-2"
                              style={{
                                aspectRatio: "1/1.4142",
                                background: "color-mix(in oklch, var(--viewer-elevated) 60%, transparent)",
                                border: isSelected ? "3px solid #ef4444" : "1px solid var(--viewer-border-sub)",
                              }}
                            >
                              <svg className="w-6 h-6 animate-spin" style={{ color: "var(--viewer-text-muted)" }} fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                              </svg>
                              <span className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>Page {page}</span>
                            </div>
                          )}
                          {isSelected && (
                            <div className="absolute inset-0 rounded flex items-center justify-center pointer-events-none"
                              style={{ background: "rgba(239, 68, 68, 0.25)" }}>
                              <div className="rounded-full p-2" style={{ background: "rgba(239, 68, 68, 0.85)" }}>
                                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </div>
                            </div>
                          )}
                          {isVisible && (
                            <TextLayer
                              pdfPath={viewerFile.path}
                              pageNum={page}
                              zoom={zoom}
                              findQuery={findOpen ? findQuery : undefined}
                              isDrawingMode={activeTool === "draw"}
                            />
                          )}
                          {isVisible && (
                            <DrawingCanvas
                              pageSlotId={slot.slotId}
                              docPath={viewerFile.path}
                              isDrawingMode={activeTool === "draw"}
                              zoom={zoom}
                            />
                          )}
                        </>
                      ) : (
                        /* Lightweight placeholder for off-screen pages — maintains scroll height */
                        <div
                          className="rounded"
                          style={{
                            aspectRatio: "1/1.4142",
                            background: "color-mix(in oklch, var(--viewer-elevated) 40%, transparent)",
                            border: isSelected ? "3px solid #ef4444" : "1px solid var(--viewer-border-sub)",
                          }}
                        />
                      )}
                    </div>
                    {/* Add-page bar after this real page */}
                    {activeTool === "draw" && (
                      <AddPageBar onAdd={() => setAddPageAt(page)} />
                    )}
                  </React.Fragment>
                );
              } else {
                // Virtual page
                const vp = slot.vp;
                const pageW = Math.round(zoom * 768);
                const pageH = Math.round(pageW * 1.4142); // A4 ratio
                return (
                  <div
                    key={slot.slotId}
                    ref={getPageRef(slot.slotId)}
                    className="relative my-4 sm:my-8 rounded shadow-2xl overflow-hidden"
                    style={{ width: `min(${pageW}px, 100%)`, aspectRatio: `${pageW}/${pageH}` }}
                  >
                    {isVisible ? (
                      <>
                        <VirtualPageBackground
                          template={vp.template}
                          width={pageW}
                          height={pageH}
                        />
                        <DrawingCanvas
                          pageSlotId={slot.slotId}
                          docPath={viewerFile.path}
                          isDrawingMode={activeTool === "draw"}
                          zoom={zoom}
                        />
                        {/* Label */}
                        <div
                          className="absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded pointer-events-none"
                          style={{
                            background: "rgba(0,0,0,0.12)",
                            color: "#888",
                            textTransform: "capitalize",
                          }}
                        >
                          {vp.template}
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              }
            })}

            {pageCount === 0 && (
              <p className="text-sm my-8" style={{ color: "var(--viewer-text-muted)" }}>
                No pages found
              </p>
            )}
          </div>
        </div>

        {/* Right: tool sidebar — hidden in draw mode (toolbar handles everything) */}
        <div
          className={`h-full flex-col ${
            activeTool === "draw"
              ? "hidden"
              : showTools
                ? "flex absolute inset-y-0 right-0 z-20 sm:static sm:flex"
                : "hidden sm:flex"
          }`}
        >
          <ToolSidebar
            file={viewerFile}
            onApplied={handleApplied}
            activeTool={activeTool}
            onToolChange={handleToolChange}
            selectedPages={selectedPages}
            onSelectedPagesChange={setSelectedPages}
            splitAfter={splitAfter}
            onSplitAfterChange={setSplitAfter}
          />
        </div>
      </div>
    </div>
  );
}

function AddPageBar({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="group flex items-center justify-center w-full" style={{ height: "28px", position: "relative" }}>
      <button
        onClick={onAdd}
        className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          background: "var(--brand)",
          color: "#fff",
          boxShadow: "0 1px 6px rgba(0,0,0,0.2)",
        }}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
        </svg>
        Add page here
      </button>
    </div>
  );
}
