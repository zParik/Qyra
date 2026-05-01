import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { useNotesStore, PageTemplate, VirtualPage } from "../store/useNotesStore";

import { usePageThumbnails, evictPathFromThumbnailCache, loadDocument } from "../hooks/usePageThumbnails";
import { PageStrip } from "./PageStrip";
import { ToolSidebar, ViewerTool } from "./ToolSidebar";
import { copyFile, showSaveDialog, bakeAnnotations, loadComments, saveComments } from "../lib/tauri";
import { triggerPrint } from "./tools/PrintPanel";
import { DrawingCanvas } from "./DrawingCanvas";
import { VirtualPageBackground } from "./VirtualPageBackground";
import { DrawToolbar } from "./tools/DrawToolbar";
import { TextLayer } from "./TextLayer";
import { FindBar } from "./FindBar";
import { CommentLayer, CommentEditor } from "./CommentLayer";
import { useCommentsStore } from "../store/useCommentsStore";

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];

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

  const [docAspectRatio, setDocAspectRatio] = useState(1.4142);

  const [zoom, setZoom] = useState(1.0);
  const [showStrip, setShowStrip] = useState(true);
  const [showTools, setShowTools] = useState(true);

  // Find-in-document
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<{ page: number }[]>([]);
  const [findCurrentIdx, setFindCurrentIdx] = useState(0);

  // Go-to-page input
  const [editingPage, setEditingPage] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");

  // Annotation tool pills (activate draw mode)
  const [activeAnnot, setActiveAnnot] = useState<string | null>(null);

  // Comments
  const commentsRef = useCommentsStore((s) => s.comments[viewerFile?.path ?? ""]);
  const comments = commentsRef ?? [];
  const loadCommentsIntoStore = useCommentsStore((s) => s.loadComments);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const isLoadingCommentsRef = useRef(false);
  // True while comment mode is active — opens the comments tab in the sidebar
  const isCommentMode = activeTool === "comment";

  // Text selection popup
  const [selectionPopup, setSelectionPopup] = useState<{
    text: string;
    rect: DOMRect;
    pageIndex: number;
    normX: number;
    normY: number;
  } | null>(null);

  // Editor opened from text selection
  const [selectionEditor, setSelectionEditor] = useState<{
    text: string;
    screenX: number;
    screenY: number;
    pageIndex: number;
    normX: number;
    normY: number;
  } | null>(null);

  // Load comments from embedded PDF attachment once on mount
  useEffect(() => {
    if (!viewerFile?.path) return;
    isLoadingCommentsRef.current = true;
    loadComments(viewerFile.path)
      .then((json) => {
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) loadCommentsIntoStore(viewerFile.path, parsed);
        } catch { /* ignore malformed JSON */ }
      })
      .catch(() => { /* file might not have comments yet */ })
      .finally(() => { isLoadingCommentsRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only: original path == viewerFile.path at this point

  // Auto-save comments to the current working PDF whenever they change
  useEffect(() => {
    if (!viewerFile?.path || isLoadingCommentsRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveComments(viewerFile.path, JSON.stringify(comments)).catch(() => {});
    }, 400);
    return () => clearTimeout(saveTimerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, viewerFile?.path]);

  // Handle text selection
  useEffect(() => {
    function handleMouseUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionPopup(null);
        return;
      }
      
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el = container.nodeType === 3 ? container.parentElement : (container as HTMLElement);
      // We only care about selections within a TextLayer
      const pageEl = el?.closest('.textLayer')?.parentElement as HTMLElement | null;
      
      if (!pageEl || !pageEl.dataset.pageIndex) {
        setSelectionPopup(null);
        return;
      }

      const pageIndex = parseInt(pageEl.dataset.pageIndex, 10);
      const pageRect = pageEl.getBoundingClientRect();
      const selRect = range.getBoundingClientRect();
      
      const normX = (selRect.left + selRect.width / 2 - pageRect.left) / pageRect.width;
      const normY = (selRect.top - pageRect.top) / pageRect.height;
      const text = sel.toString().trim();
      
      if (!text) {
        setSelectionPopup(null);
        return;
      }

      setSelectionPopup({
        text,
        rect: selRect,
        pageIndex,
        normX,
        normY,
      });
    }

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  function adjustZoom(delta: number) {
    setZoom((prev) => {
      const next = Math.round((prev + delta) * 100) / 100;
      return Math.min(3.0, Math.max(0.25, next));
    });
  }

  function handleToolChange(tool: ViewerTool | null) {
    setActiveTool(tool);
    if (tool !== "remove") setSelectedPages(new Set());
    if (tool === "comment") {
      setActiveAnnot("Comment");
    } else if (tool === "draw") {
      setActiveAnnot((prev) => (prev === "Highlight" || prev === "Sign" ? prev : "Highlight"));
    } else {
      setActiveAnnot(null);
    }
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

  // --- Virtual scroll for center pane ---
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [centerScrollTop, setCenterScrollTop] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Slot height: page content (A4 aspect ratio at current zoom) + vertical margins (sm:my-8 = 32px each side)
  const SLOT_MARGIN = 64;   // 32px top + 32px bottom per slot
  const TOP_PAD    = 32;    // sm:py-8
  const SIDE_PAD   = 32;    // sm:px-8
  const BUFFER_SLOTS = 2;   // small buffer to avoid gaps when scrolling

  const basePageW = zoom * 768;
  const actualPageW = containerWidth > 0 ? Math.min(basePageW, containerWidth - SIDE_PAD * 2) : basePageW;
  const slotH = actualPageW * docAspectRatio + SLOT_MARGIN;
  const containerH = scrollContainerRef.current?.clientHeight ?? 600;
  const firstSlot  = Math.max(0, Math.floor((centerScrollTop - TOP_PAD) / slotH) - BUFFER_SLOTS);
  const lastSlot   = Math.min(pageSlots.length - 1, Math.ceil((centerScrollTop + containerH - TOP_PAD) / slotH) + BUFFER_SLOTS);
  const totalH     = TOP_PAD * 2 + pageSlots.length * slotH;

  // Visible PDF page numbers come from the virtual scroll window — no IntersectionObserver needed
  const visiblePageNums = useMemo(() => {
    const nums = new Set<number>();
    for (let i = firstSlot; i <= lastSlot; i++) {
      const slot = pageSlots[i];
      if (slot?.type === 'pdf') nums.add(slot.pdfPage);
    }
    return nums;
  }, [firstSlot, lastSlot, pageSlots]);

  // O(1) lookup: PDF page number → slot index, used by scrollToPage
  const pageToSlotIndex = useMemo(() => {
    const m = new Map<number, number>();
    pageSlots.forEach((slot, i) => { if (slot.type === 'pdf') m.set(slot.pdfPage, i); });
    return m;
  }, [pageSlots]);

  const [stripVisibleRange, setStripVisibleRange] = useState<[number, number]>([1, 20]);
  const stripVisibleNums = useMemo(() => {
    const s = new Set<number>();
    if (pageCount > 0) s.add(1); // always render page 1 regardless of scroll position
    for (let p = stripVisibleRange[0]; p <= stripVisibleRange[1]; p++) s.add(p);
    return s;
  }, [stripVisibleRange, pageCount]);

  const stripThumbnails = usePageThumbnails(viewerFile?.path ?? null, pageCount, 0.3, stripVisibleNums);
  // Match render scale to current zoom instead of always over-rendering at 1.5x.
  const centerRenderScale = Math.min(2.0, Math.max(1.0, zoom * 1.15));
  const centerThumbnails = usePageThumbnails(viewerFile?.path ?? null, pageCount, centerRenderScale, visiblePageNums);

  // Re-anchor scroll position when zoom changes so the current page stays in view
  const prevZoomRef = useRef(zoom);
  const prevAspectRef = useRef(docAspectRatio);
  const prevContainerWidthRef = useRef(containerWidth);
  useEffect(() => {
    if (prevZoomRef.current === zoom && prevAspectRef.current === docAspectRatio && prevContainerWidthRef.current === containerWidth) return;
    prevZoomRef.current = zoom;
    prevAspectRef.current = docAspectRatio;
    prevContainerWidthRef.current = containerWidth;
    const container = scrollContainerRef.current;
    if (!container) return;
    const idx = pageToSlotIndex.get(currentPage) ?? 0;
    const baseW = zoom * 768;
    const actW = containerWidth > 0 ? Math.min(baseW, containerWidth - SIDE_PAD * 2) : baseW;
    const newSlotH = actW * docAspectRatio + SLOT_MARGIN;
    const newSt = TOP_PAD + idx * newSlotH;
    container.scrollTop = newSt;
    setCenterScrollTop(newSt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, docAspectRatio, containerWidth]);

  useEffect(() => {
    if (!viewerFile) navigate("/");
  }, [viewerFile]);

  // Fetch aspect ratio of the first page to correctly size the virtual scroll slots
  useEffect(() => {
    if (!viewerFile?.path) return;
    let cancelled = false;
    async function fetchAspectRatio() {
      try {
        const doc = await loadDocument(viewerFile!.path);
        if (cancelled) return;
        const page = await doc.getPage(1);
        if (cancelled) return;
        const vp = page.getViewport({ scale: 1 });
        if (vp.width > 0 && vp.height > 0) {
          setDocAspectRatio(vp.height / vp.width);
        }
      } catch {}
    }
    fetchAspectRatio();
    return () => { cancelled = true; };
  }, [viewerFile?.path]);

  // Populate page count fast via Rust (reads only XRef + 2 objects — no full parse).
  // Falls back to PDF.js range requests if the fast path fails (e.g. XRef streams).
  // PDF.js loadDocument is NOT called eagerly here — it's deferred until the first
  // page actually needs rendering, which eliminates the XRef-parsing CPU spike on open.
  useEffect(() => {
    if (!viewerFile?.path) return;
    if (viewerFile.info?.page_count) return;

    let cancelled = false;
    const path = viewerFile.path;

    async function loadPageCount() {
      const { invoke } = await import("@tauri-apps/api/core");
      let count = 0;
      let fileSize = 0;
      try {
        count = await invoke<number>("get_page_count", { path });
      } catch {
        // Fast path failed (XRef stream PDF) — fall back to PDF.js
        try {
          const doc = await loadDocument(path);
          count = doc.numPages;
        } catch { return; }
      }
      try {
        fileSize = await invoke<number>("get_file_size", { path });
      } catch {
        fileSize = 0;
      }
      if (cancelled || count <= 0) return;
      const current = useAppStore.getState().viewerFile;
      if (current?.path !== path) return;
      setViewerFile({ ...current, info: { file_size: fileSize, metadata: {}, page_count: count } });
      // Skip background metadata load for large PDFs — getPdfInfo parses the entire document
      // which causes a CPU spike. Metadata is nice-to-have, not essential.
    }

    loadPageCount();
    return () => { cancelled = true; };
  }, [viewerFile?.path]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const st = container.scrollTop;
    setCenterScrollTop(st);
    // Derive current page from scroll position — O(1), no DOM queries
    const rawIdx = Math.max(0, Math.min(pageSlots.length - 1, Math.round((st - TOP_PAD) / slotH)));
    for (let i = rawIdx; i >= 0; i--) {
      const slot = pageSlots[i];
      if (slot?.type === 'pdf') { setCurrentPage(slot.pdfPage); break; }
    }
  }

  function scrollToPage(page: number) {
    setCurrentPage(page);
    const container = scrollContainerRef.current;
    if (!container) return;
    const idx = pageToSlotIndex.get(page) ?? 0;
    const newSt = TOP_PAD + idx * slotH;
    container.scrollTop = newSt;
    setCenterScrollTop(newSt);
  }

  function handleOpenFile(path: string) {
    const name = path.split(/[\\/]/).pop() ?? path;
    // Set immediately — page count + info will populate via the lazy effect above
    setViewerFile({ path, name });
    setCurrentPage(1);
  }

  async function handleApplied(path: string) {
    setUndoViewerFile(viewerFile); // snapshot for Ctrl+Z
    handleOpenFile(path);
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
      handleOpenFile(originalViewerPath);
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
      handleOpenFile(chosenPath);
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
      {/* Header — dense pro-tool toolbar */}
      <header
        style={{
          height: 44, flexShrink: 0,
          background: "var(--viewer-surface)",
          borderBottom: "1px solid var(--viewer-border)",
          paddingTop: "env(safe-area-inset-top, 0px)",
          display: "flex", alignItems: "center",
          gap: 8, padding: "0 12px",
        }}
      >
        {/* ← Library */}
        <button
          onClick={handleBack}
          className="v-icon-btn shrink-0"
          title="Back to home"
          style={{
            height: 26, padding: "0 8px", borderRadius: 4,
            display: "inline-flex", alignItems: "center", gap: 5,
            border: "1px solid var(--viewer-border)",
            background: "var(--viewer-elevated)",
            fontSize: 11.5, fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <svg width={11} height={11} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
            <path d="M10 4L6 8l4 4" />
          </svg>
          <span className="hidden sm:inline">Library</span>
        </button>

        <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />

        {/* File title */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
          <svg width={14} height={14} fill="currentColor" viewBox="0 0 24 24"
            style={{ color: "var(--accent)", flexShrink: 0 }}>
            <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{
              fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, fontWeight: 600,
              color: "var(--viewer-text)", overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", maxWidth: 260, lineHeight: 1.1,
            }}>
              {displayName}
            </span>
            {viewerFile.info && (
              <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, color: "var(--viewer-text-muted)", lineHeight: 1.1 }}>
                {viewerFile.info.page_count} pages
                {isViewerDirty && <span style={{ color: "oklch(65% 0.16 65)", marginLeft: 5 }}>● unsaved</span>}
              </span>
            )}
          </div>
        </div>

        {/* Annotation tool pills */}
        <div style={{ display: "flex", gap: 1, padding: 2, border: "1px solid var(--viewer-border)", borderRadius: 4, flexShrink: 0 }}>
          {(["Highlight", "Comment", "Sign"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                const targetTool = t === "Comment" ? "comment" : "draw";
                if (activeTool === targetTool && activeAnnot === t) {
                  handleToolChange(null);
                } else {
                  setActiveAnnot(t);
                  handleToolChange(targetTool);
                }
              }}
              style={{
                padding: "3px 9px", border: "none", borderRadius: 3,
                background: activeAnnot === t && (activeTool === "draw" || activeTool === "comment") ? "var(--accent-soft)" : "transparent",
                color: activeAnnot === t && (activeTool === "draw" || activeTool === "comment") ? "var(--accent)" : "var(--viewer-text-muted)",
                fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11.5, fontWeight: 500,
                cursor: "pointer", transition: "background 100ms, color 100ms",
              }}
            >{t}</button>
          ))}
        </div>

        {/* ── right cluster ── */}

        {/* Undo */}
        {undoViewerFile && (
          <>
            <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />
            <button
              onClick={() => {
                setViewerFile(undoViewerFile);
                setUndoViewerFile(null);
                setIsViewerDirty(undoViewerFile.path !== (originalViewerPath ?? ""));
                setCurrentPage(1);
              }}
              className="v-btn-secondary-sm shrink-0"
              title="Undo last operation (Ctrl+Z)"
              style={{ height: 26, padding: "0 8px", borderRadius: 4, fontSize: 11.5,
                display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5}
                strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              <span className="hidden sm:inline">Undo</span>
            </button>
          </>
        )}

        {/* Save */}
        {isViewerDirty && (
          <>
            <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button onClick={handleSave} className="v-btn-primary-sm"
                title="Save (Ctrl+S)"
                style={{ height: 26, padding: "0 10px", borderRadius: 4, fontSize: 11.5, fontWeight: 600 }}>
                Save
              </button>
              <button onClick={handleSaveAs} className="v-btn-secondary-sm hidden sm:inline-flex"
                title="Save As (Ctrl+Shift+S)"
                style={{ height: 26, padding: "0 10px", borderRadius: 4, fontSize: 11.5 }}>
                Save As
              </button>
            </div>
          </>
        )}

        <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />

        {/* Zoom */}
        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          <VHeaderBtn onClick={() => adjustZoom(-0.25)} disabled={zoom <= 0.25} title="Zoom out (Ctrl+-)">
            <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" viewBox="0 0 16 16"><path d="M3 8h10" /></svg>
          </VHeaderBtn>
          <button
            onClick={() => setZoom(1.0)}
            title="Reset zoom (Ctrl+0)"
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11,
              color: "var(--viewer-text-muted)", minWidth: "3rem", textAlign: "center", padding: "0 2px",
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <VHeaderBtn onClick={() => adjustZoom(0.25)} disabled={zoom >= 3.0} title="Zoom in (Ctrl+=)">
            <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>
          </VHeaderBtn>
        </div>

        <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />

        {/* Page nav */}
        {pageCount > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            <VHeaderBtn onClick={() => currentPage > 1 && scrollToPage(currentPage - 1)} title="Previous page">
              <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5}
                strokeLinecap="round" viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" /></svg>
            </VHeaderBtn>
            {editingPage ? (
              <input
                type="number" min={1} max={pageCount} value={pageInputValue} autoFocus
                style={{
                  width: "5rem", textAlign: "center",
                  background: "var(--viewer-elevated)", border: "1px solid var(--viewer-border)",
                  borderRadius: 4, color: "var(--viewer-text)", caretColor: "var(--viewer-text)",
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, padding: "2px 4px",
                  outline: "none",
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
                onClick={() => { setPageInputValue(String(currentPage)); setEditingPage(true); }}
                title="Go to page"
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11,
                  color: "var(--viewer-text-muted)", minWidth: "5rem", textAlign: "center", padding: "0 2px",
                }}
              >
                {String(currentPage).padStart(3, "0")}<span style={{ color: "var(--viewer-border)" }}> / </span>{pageCount}
              </button>
            )}
            <VHeaderBtn onClick={() => currentPage < pageCount && scrollToPage(currentPage + 1)} title="Next page">
              <svg width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5}
                strokeLinecap="round" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
            </VHeaderBtn>
          </div>
        )}

        {/* Mobile toggles */}
        <button
          onClick={() => setShowStrip(s => !s)}
          className="v-icon-btn shrink-0"
          title="Toggle page strip"
          style={{
            width: 28, height: 28, borderRadius: 4, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            color: showStrip ? "var(--accent)" : undefined,
          }}
        >
          <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
        </button>
        <button
          onClick={() => setShowTools(t => !t)}
          className="v-icon-btn shrink-0"
          title="Toggle tools"
          style={{
            width: 28, height: 28, borderRadius: 4, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            color: showTools ? "var(--accent)" : undefined,
          }}
        >
          <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
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

      {/* Selection Popup Tooltip */}
      {selectionPopup && !selectionEditor && (
        <div
          style={{
            position: "fixed",
            left: selectionPopup.rect.left + selectionPopup.rect.width / 2,
            top: selectionPopup.rect.top - 40,
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "var(--viewer-elevated)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6,
            padding: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            display: "flex",
          }}
          onMouseDown={(e) => e.preventDefault()} // Prevent losing text selection
        >
          <button
            onClick={() => {
              setSelectionEditor({
                text: selectionPopup.text,
                screenX: selectionPopup.rect.left + selectionPopup.rect.width / 2,
                screenY: selectionPopup.rect.top,
                pageIndex: selectionPopup.pageIndex,
                normX: selectionPopup.normX,
                normY: selectionPopup.normY,
              });
              setSelectionPopup(null);
              window.getSelection()?.removeAllRanges();
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--viewer-text)",
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: 12,
              fontWeight: 500,
              padding: "4px 8px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            Add Comment
          </button>
        </div>
      )}

      {/* Global Comment Editor for text selections */}
      {selectionEditor && (
        <CommentEditor
          comment={null}
          x={selectionEditor.screenX}
          y={selectionEditor.screenY}
          docPath={viewerFile.path}
          pageIndex={selectionEditor.pageIndex}
          normX={selectionEditor.normX}
          normY={selectionEditor.normY}
          quote={selectionEditor.text}
          onClose={() => setSelectionEditor(null)}
        />
      )}

      {/* Three-panel body */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left: page strip — always visible on desktop, slide-in drawer on mobile */}
        <div
          className={`h-full shrink-0 flex-col ${
            showStrip
              ? "flex absolute inset-y-0 left-0 z-20 sm:relative sm:z-auto"
              : "hidden"
          }`}
        >
          <PageStrip
            pageCount={pageCount}
            thumbnails={stripThumbnails}
            currentPage={currentPage}
            onPageSelect={(page) => {
              scrollToPage(page);
              if (window.innerWidth < 640) setShowStrip(false);
            }}
            selectionMode={activeTool === "remove"}
            selectedPages={selectedPages}
            onPageToggle={handlePageToggle}
            splitAfter={activeTool === "split" ? splitAfter : undefined}
            onSplitAfterChange={activeTool === "split" ? setSplitAfter : undefined}
            onVisibleRangeChange={setStripVisibleRange}
          />
        </div>

        {/* Center: continuous scroll canvas */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto"
          style={{ background: "var(--viewer-canvas)" }}
          onScroll={handleScroll}
        >
          {/* "Add page" template picker — fixed overlay, unaffected by virtual scroll */}
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

          {pageCount === 0 && (
            <p className="text-sm m-8" style={{ color: "var(--viewer-text-muted)" }}>
              No pages found
            </p>
          )}

          {/* Virtual scroll container — only renders the visible window of slots */}
          <div style={{ position: "relative", height: totalH }}>

            {/* Add-page bar before first page (draw mode) */}
            {activeTool === "draw" && pageSlots.length > 0 && (
              <div style={{ position: "absolute", top: 4, left: SIDE_PAD, right: SIDE_PAD }}>
                <AddPageBar onAdd={() => setAddPageAt(0)} />
              </div>
            )}

            {pageSlots.slice(firstSlot, lastSlot + 1).map((slot, i) => {
              const slotIndex = firstSlot + i;
              const topPos = TOP_PAD + slotIndex * slotH;

              if (slot.type === 'pdf') {
                const page = slot.pdfPage;
                const pageW = Math.round(zoom * 768);
                const isSelected = activeTool === "remove" && selectedPages.has(page);
                const shouldRenderTextLayer = true; // all visible pages (virtual scroll limits active pages)
                return (
                  <React.Fragment key={slot.slotId}>
                    <div
                      style={{
                        position: "absolute",
                        top: topPos + SLOT_MARGIN / 2,
                        left: 0,
                        right: 0,
                        display: "flex",
                        justifyContent: "center",
                        paddingLeft: SIDE_PAD,
                        paddingRight: SIDE_PAD,
                      }}
                    >
                      <div
                        className="relative"
                        data-page-index={page}
                        style={{
                          width: `min(${pageW}px, 100%)`,
                          cursor: activeTool === "remove" ? "pointer" : undefined,
                        }}
                        onClick={activeTool === "remove" ? () => handlePageToggle(page) : undefined}
                      >
                        {centerThumbnails[page] ? (
                          <img
                            src={centerThumbnails[page]}
                            alt={`Page ${page}`}
                            className="w-full rounded shadow-2xl block"
                            draggable={false}
                            style={{ height: "auto", display: "block", ...(isSelected ? { outline: "3px solid #ef4444", borderRadius: "0.5rem" } : {}) }}
                          />
                        ) : (
                          <div
                            className="rounded flex flex-col items-center justify-center gap-2"
                            style={{
                              aspectRatio: `1/${docAspectRatio}`,
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
                        <TextLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          zoom={zoom}
                          findQuery={findOpen ? findQuery : undefined}
                          isDrawingMode={activeTool === "draw"}
                          enabled={shouldRenderTextLayer}
                        />
                        <DrawingCanvas
                          pageSlotId={slot.slotId}
                          docPath={viewerFile.path}
                          isDrawingMode={activeTool === "draw"}
                          zoom={zoom}
                        />
                        <CommentLayer
                          pageIndex={page}
                          docPath={viewerFile.path}
                          isCommentMode={isCommentMode}
                        />
                      </div>
                    </div>
                    {/* Add-page bar after this page (draw mode) */}
                    {activeTool === "draw" && (
                      <div style={{ position: "absolute", top: topPos + slotH - 28, left: SIDE_PAD, right: SIDE_PAD }}>
                        <AddPageBar onAdd={() => setAddPageAt(page)} />
                      </div>
                    )}
                  </React.Fragment>
                );
              } else {
                // Virtual (blank/ruled/grid/dotted) page
                const vp = slot.vp;
                const pageW = Math.round(zoom * 768);
                const pageH = Math.round(pageW * docAspectRatio);
                return (
                  <div
                    key={slot.slotId}
                    style={{
                      position: "absolute",
                      top: topPos + SLOT_MARGIN / 2,
                      left: 0,
                      right: 0,
                      display: "flex",
                      justifyContent: "center",
                      paddingLeft: SIDE_PAD,
                      paddingRight: SIDE_PAD,
                    }}
                  >
                    <div
                      className="relative rounded shadow-2xl overflow-hidden"
                      style={{ width: `min(${pageW}px, 100%)`, aspectRatio: `${pageW}/${pageH}` }}
                    >
                      <VirtualPageBackground template={vp.template} width={pageW} height={pageH} />
                      <DrawingCanvas
                        pageSlotId={slot.slotId}
                        docPath={viewerFile.path}
                        isDrawingMode={activeTool === "draw"}
                        zoom={zoom}
                      />
                      <div
                        className="absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded pointer-events-none"
                        style={{ background: "rgba(0,0,0,0.12)", color: "#888", textTransform: "capitalize" }}
                      >
                        {vp.template}
                      </div>
                    </div>
                  </div>
                );
              }
            })}
          </div>
        </div>

        {/* Right: tool sidebar — hidden in draw mode (toolbar handles everything) */}
        <div
          className={`h-full flex-col ${
            activeTool === "draw" || !showTools
              ? "hidden"
              : "flex absolute inset-y-0 right-0 z-20 sm:relative sm:z-auto"
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
            onPageSelect={scrollToPage}
            forceCommentsTab={isCommentMode}
          />
        </div>
      </div>
    </div>
  );
}

function VHeaderBtn({ onClick, disabled, title, children }: {
  onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 22, height: 22, borderRadius: 3,
        border: "1px solid var(--viewer-border)",
        background: "var(--viewer-elevated)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        color: "var(--viewer-text-muted)",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
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
