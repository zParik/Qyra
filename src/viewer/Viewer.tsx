import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { useNotesStore, PageTemplate, VirtualPage } from "../store/useNotesStore";

import { usePageThumbnails, evictPathFromThumbnailCache } from "../hooks/usePageThumbnails";
import { PageStrip } from "./PageStrip";
import { ScrollPageIndicator } from "./ScrollPageIndicator";
import { ToolSidebar, ViewerTool } from "./ToolSidebar";
import { invoke } from "@tauri-apps/api/core";
import { copyFile, showSaveDialog, bakeAnnotations, setActiveDocument } from "../lib/tauri";
import { triggerPrint } from "./tools/PrintPanel";
import { DrawingCanvas } from "./DrawingCanvas";
import { VirtualPageBackground } from "./VirtualPageBackground";
import { DrawToolbar } from "./tools/DrawToolbar";
import { TextLayer } from "./TextLayer";
import { LinkLayer } from "./LinkLayer";
import { FindBar } from "./FindBar";
import { CommentLayer, CommentEditor } from "./CommentLayer";
import { FormLayer } from "./FormLayer";
import { AnnotationLayer } from "./AnnotationLayer";
import { SignatureLayer } from "./SignatureLayer";
import { RedactLayer } from "./RedactLayer";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { SignaturePanel } from "./tools/SignaturePanel";
import { useFormFilling } from "./useFormFilling";
import { PresentationMode } from "./PresentationMode";
import { useComments } from "./hooks/useComments";
import { useViewerUI } from "./hooks/useViewerUI";
import { useToolMode } from "./hooks/useToolMode";
import { useFindInDocument } from "./hooks/useFindInDocument";
import { useSignatures } from "./hooks/useSignatures";
import { useTextSelection } from "./hooks/useTextSelection";
import { useGoToPage } from "./hooks/useGoToPage";
import { useRedactRegions } from "./hooks/useRedactRegions";
import { useAutoSave } from "./hooks/useAutoSave";
// import { getPageOcrText } from "../lib/ocrEngine";

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];

/** 0-based index of the current find hit among hits on `page`, or -1 if none. */
function findActiveMatchOrdinalOnPage(
  page: number,
  findMatches: { page: number }[],
  globalIdx: number
): number {
  if (findMatches.length === 0 || globalIdx < 0 || globalIdx >= findMatches.length) return -1;
  if (findMatches[globalIdx]!.page !== page) return -1;
  let ordinal = -1;
  for (let i = 0; i <= globalIdx; i++) {
    if (findMatches[i]!.page === page) ordinal++;
  }
  return ordinal;
}

export default function Viewer({ tabPath }: { tabPath: string }) {
  const navigate = useNavigate();
  const viewerFile = useAppStore((s) => {
    const file = s.tabFiles[tabPath];
    const tab = s.openTabs.find((t) => t.path === tabPath);
    return file ?? tab ?? null;
  });
  const isViewerDirty = useAppStore((s) => s.tabDirty[tabPath] ?? false);
  const undoViewerFile = useAppStore((s) => s.tabUndo[tabPath] ?? null);
  const originalViewerPath = useAppStore((s) => s.tabOriginal[tabPath] ?? tabPath);
  const setTabFileAction = useAppStore((s) => s.setTabFile);
  const setTabDirtyAction = useAppStore((s) => s.setTabDirty);
  const setTabUndoAction = useAppStore((s) => s.setTabUndo);
  const setTabOriginalAction = useAppStore((s) => s.setTabOriginal);

  const setViewerFile = (file: import("../store/useAppStore").LoadedFile | null) => {
    if (file) setTabFileAction(tabPath, file);
  };
  const setIsViewerDirty = (v: boolean) => setTabDirtyAction(tabPath, v);
  const setUndoViewerFile = (file: import("../store/useAppStore").LoadedFile | null) => setTabUndoAction(tabPath, file);
  const setOriginalViewerPath = (p: string | null) => { if (p) setTabOriginalAction(tabPath, p); };
  const [currentPage, setCurrentPage] = useState(1);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const undoStroke = useNotesStore((s) => s.undoStroke);
  const virtualPages = useNotesStore((s) => s.virtualPages[viewerFile?.path ?? ""] ?? EMPTY_VIRTUAL_PAGES);
  const addVirtualPage = useNotesStore((s) => s.addVirtualPage);

  // "Add page" inline UI: which insertion point is open (afterRealPage value)
  const [addPageAt, setAddPageAt] = useState<number | null>(null);

  const [docAspectRatio, setDocAspectRatio] = useState(1.4142);
  const [zoom, setZoom] = useState(1.0);

  // Viewer UI: chrome visibility, reading/presentation modes, back-confirm overlay
  const {
    showStrip, setShowStrip,
    showTools, setShowTools,
    readingMode, setReadingMode,
    showPresentation, setShowPresentation,
    confirmingBack, setConfirmingBack,
  } = useViewerUI();

  // ToolSidebar (full-screen on phone) dispatches this when its × is tapped
  useEffect(() => {
    const close = () => setShowTools(false);
    window.addEventListener("viewer:closeTools", close);
    return () => window.removeEventListener("viewer:closeTools", close);
  }, [setShowTools]);

  // Tool-mode cluster (activeTool, selectedPages, splitAfter, annotation pills)
  const initialSplitAfter = Math.max(1, Math.floor((viewerFile?.info?.page_count ?? 2) / 2));
  const {
    activeTool, setActiveTool,
    selectedPages, setSelectedPages,
    splitAfter, setSplitAfter,
    activeAnnot, setActiveAnnot,
    activeAnnotTool, setActiveAnnotTool,
    annotColor, setAnnotColor,
    annotRefreshKey, setAnnotRefreshKey,
  } = useToolMode(initialSplitAfter);

  // Redaction state (regions + mode)
  const { redactRegions, setRedactRegions, redactMode, setRedactMode } = useRedactRegions(viewerFile?.path);

  // Auto-save preference + timers
  const { autoSave, setAutoSave, autoSaveRef, autoSaveTimerRef, savedFeedbackTimerRef } = useAutoSave();

  // Go-to-page input state
  const { editingPage, setEditingPage, pageInputValue, setPageInputValue } = useGoToPage();

  // E-signature state
  const {
    signatures, setSignatures,
    pendingSignature, setPendingSignature,
    showSignaturePanel, setShowSignaturePanel,
  } = useSignatures();

  // Form filling
  const { fieldValues, setFieldValue, saveFormFields: _saveFormFields, isDirty: _isFormDirty } = useFormFilling();

  // Comments (loads on mount, auto-saves on change). The comments themselves
  // are read by CommentLayer/sidebar via useCommentsStore — Viewer only needs
  // the hook to wire up the load and auto-save effects.
  useComments(viewerFile?.path);

  // Restore page + zoom from SQLite when this tab is mounted
  useEffect(() => {
    invoke<[number, number]>("get_tab_ui_state", { path: tabPath }).then(([page, z]) => {
      if (page > 1) setCurrentPage(page);
      if (z !== 1.0) setZoom(z);
    }).catch(() => {});
  }, [tabPath]);

  const uiStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
    uiStateTimerRef.current = setTimeout(() => {
      invoke("save_tab_ui_state", {
        path: tabPath,
        currentPage,
        zoom,
      }).catch(() => {});
    }, 800);
    return () => {
      if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
    };
  }, [tabPath, currentPage, zoom]);

  // True while comment mode is active — opens the comments tab in the sidebar
  const isCommentMode = activeTool === "comment";

  // Text selection popup + editor
  const { selectionPopup, setSelectionPopup, selectionEditor, setSelectionEditor } = useTextSelection();

  // scrollToPage is defined later in the body but the find-in-document hook
  // needs to call it; route the call through a ref so the hook can fire
  // before the function literal exists.
  const scrollToPageRef = useRef<(page: number) => void>(() => {});

  // Find-in-document state + search effects
  const {
    findOpen, setFindOpen,
    findQuery, setFindQuery,
    findMatches,
    findCurrentIdx, setFindCurrentIdx,
    ocrSearching, ocrProgress,
  } = useFindInDocument(viewerFile?.path, viewerFile?.info?.page_count ?? 0, (page) => scrollToPageRef.current(page));

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
    } else if (tool === "signature") {
      setShowSignaturePanel(true);
      setActiveAnnot("Sign");
    } else if (tool === "annotate") {
      setActiveAnnot(null);
    } else if (tool === "forms") {
      setActiveAnnot(null);
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
  const actualPageW = basePageW;
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

  const [stripVisibleRange, setStripVisibleRange] = useState<[number, number]>([1, 5]);
  const stripVisibleNums = useMemo(() => {
    const s = new Set<number>();
    if (pageCount > 0) s.add(1); // always render page 1 regardless of scroll position
    for (let p = stripVisibleRange[0]; p <= stripVisibleRange[1]; p++) s.add(p);
    return s;
  }, [stripVisibleRange, pageCount]);

  const stripThumbnails = usePageThumbnails(viewerFile?.path ?? null, pageCount, 0.3, stripVisibleNums);
  // Render at physical pixel density: multiply by dpr so HiDPI screens get crisp pages.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const centerRenderScale = Math.min(3.0, Math.max(1.0, zoom * 1.5 * dpr));
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
    const actW = zoom * 768;
    const newSlotH = actW * docAspectRatio + SLOT_MARGIN;
    const newSt = TOP_PAD + idx * newSlotH;
    container.scrollTop = newSt;
    setCenterScrollTop(newSt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, docAspectRatio, containerWidth]);

  useEffect(() => {
    if (!viewerFile) navigate("/");
  }, [viewerFile]);

  // Fetch aspect ratio of the first page via MuPDF (Rust) — no WebView parse spike.
  useEffect(() => {
    if (!viewerFile?.path) return;
    let cancelled = false;
    async function fetchAspectRatio() {
      try {
        const ratio = await invoke<number>("get_page_aspect_ratio", { path: viewerFile!.path });
        if (!cancelled && ratio > 0) setDocAspectRatio(ratio);
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
    setLoadError(null);
    if (viewerFile.info?.page_count) return;

    let cancelled = false;
    const path = viewerFile.path;

    async function loadPageCount() {
      let count = 0;
      let fileSize = 0;
      try {
        count = await invoke<number>("get_page_count", { path });
      } catch (e) {
        if (!cancelled) {
          const msg = String(e).toLowerCase();
          const isEncrypted = msg.includes("password") || msg.includes("encrypt") || msg.includes("no password");
          setLoadError(isEncrypted ? "encrypted" : "corrupt");
        }
        return;
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

  // Synchronise currently active document path with the Rust backend for instant thread cancellation
  useEffect(() => {
    if (!viewerFile?.path) return;
    const path = viewerFile.path;
    setActiveDocument(path).catch(() => {});
    return () => {
      setActiveDocument(null).catch(() => {});
    };
  }, [viewerFile?.path]);

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
          // Magnet: snap to fit-width only when crossing into the zone (not when already there)
          const inZone = (z: number) => Math.abs(z - fitZoom) < fitZoom * 0.04;
          if (!inZone(prev) && inZone(next)) return fitZoom;
          return next;
        });
      }
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // Pinch-to-zoom via touch (two-finger gesture on Android / iOS)
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    let lastDist = 0;

    function pinchDist(e: TouchEvent) {
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) lastDist = pinchDist(e);
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || lastDist === 0) return;
      e.preventDefault();
      const dist = pinchDist(e);
      const factor = dist / lastDist;
      lastDist = dist;
      setZoom((prev) => Math.min(3.0, Math.max(0.25, prev * factor)));
    }

    function onTouchEnd() { lastDist = 0; }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  // scrollContainerRef.current is stable after mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fit zoom on small screens so the PDF isn't wider than the viewport
  useEffect(() => {
    if (window.innerWidth >= 640) return;
    const fitZoom = (window.innerWidth - 32) / 768;
    setZoom(Math.max(0.25, Math.min(1.0, fitZoom)));
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "Escape" && readingMode) {
        e.preventDefault();
        setReadingMode(false);
        return;
      }

      if (e.key === "Escape" && showPresentation) {
        e.preventDefault();
        setShowPresentation(false);
        return;
      }

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
        e.preventDefault();
        if (activeTool === "draw") handleSaveAnnotations();
        else handleSave();
        return;
      }
      if (mod && e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); handleSaveAs();
        return;
      }
      if (!mod && (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown")) {
        e.preventDefault();
        if (currentPage < pageCount) scrollToPage(currentPage + 1);
        return;
      }
      if (!mod && (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp")) {
        e.preventDefault();
        if (currentPage > 1) scrollToPage(currentPage - 1);
        return;
      }
      if (!mod && e.key === "Home") {
        e.preventDefault();
        if (currentPage !== 1) scrollToPage(1);
        return;
      }
      if (!mod && e.key === "End") {
        e.preventDefault();
        if (pageCount > 0 && currentPage !== pageCount) scrollToPage(pageCount);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isViewerDirty, confirmingBack, findOpen, currentPage, pageCount, viewerFile, undoViewerFile, originalViewerPath, zoom, activeTool, undoStroke, readingMode, showPresentation]);

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
    setActiveDocument(null).catch(() => {});
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
  // Keep the find-in-document hook's nav callback pointing at the latest closure.
  scrollToPageRef.current = scrollToPage;

  function handleOpenFile(path: string) {
    const name = path.split(/[\\/]/).pop() ?? path;
    // Set immediately — page count + info will populate via the lazy effect above
    setViewerFile({ path, name });
    setCurrentPage(1);
  }

  function markSaved() {
    clearTimeout(savedFeedbackTimerRef.current);
    setSaveStatus("saved");
    savedFeedbackTimerRef.current = window.setTimeout(
      () => setSaveStatus((s) => (s === "saved" ? "idle" : s)),
      2500
    );
  }

  async function triggerAutoSave() {
    const store = useAppStore.getState();
    const vf = store.viewerFile;
    const origPath = store.originalViewerPath;
    if (!vf) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      if (!origPath) {
        const chosenPath = await showSaveDialog(vf.path);
        if (!chosenPath) { setSaveStatus("idle"); return; }
        await copyFile(vf.path, chosenPath);
        evictPathFromThumbnailCache(chosenPath);
        store.setViewerFile({ ...vf, path: chosenPath, name: chosenPath.split(/[\\/]/).pop() ?? chosenPath });
        store.setOriginalViewerPath(chosenPath);
        store.setIsViewerDirty(false);
      } else if (store.isViewerDirty) {
        await copyFile(vf.path, origPath);
        evictPathFromThumbnailCache(origPath);
        store.setViewerFile({ ...vf, path: origPath, name: origPath.split(/[\\/]/).pop() ?? origPath });
        store.setIsViewerDirty(false);
      }
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleApplied(path: string) {
    setUndoViewerFile(viewerFile); // snapshot for Ctrl+Z
    handleOpenFile(path);
    setIsViewerDirty(true);
    if (autoSaveRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = window.setTimeout(triggerAutoSave, 1500);
    }
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
    if (!viewerFile) return;
    if (!originalViewerPath) return handleSaveAs();
    if (!isViewerDirty) { markSaved(); return; }
    setSaveError(null);
    setSaveStatus("saving");
    try {
      await copyFile(viewerFile.path, originalViewerPath);
      evictPathFromThumbnailCache(originalViewerPath);
      setViewerFile({ ...viewerFile, path: originalViewerPath, name: originalViewerPath.split(/[\\/]/).pop() ?? originalViewerPath });
      setIsViewerDirty(false);
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAs() {
    if (!viewerFile) return;
    setSaveError(null);
    const chosenPath = await showSaveDialog(viewerFile.path);
    if (!chosenPath) return;
    setSaveStatus("saving");
    try {
      await copyFile(viewerFile.path, chosenPath);
      evictPathFromThumbnailCache(chosenPath);
      setViewerFile({ ...viewerFile, path: chosenPath, name: chosenPath.split(/[\\/]/).pop() ?? chosenPath });
      setOriginalViewerPath(chosenPath);
      setIsViewerDirty(false);
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAnnotations() {
    if (!viewerFile) return;
    if (!originalViewerPath) return handleSaveAsAnnotations();
    setSaveError(null);
    setSaveStatus("saving");

    const allStrokes = useNotesStore.getState().strokes[viewerFile.path] ?? [];
    const docVirtualPages = useNotesStore.getState().virtualPages[viewerFile.path] ?? [];

    const byPage = new Map<number, typeof allStrokes>();
    const byVirtualId = new Map<string, typeof allStrokes>();
    for (const s of allStrokes) {
      if (s.pageSlotId.startsWith('pdf-')) {
        const page = parseInt(s.pageSlotId.slice(4), 10);
        if (isNaN(page)) continue;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(s);
      } else {
        if (!byVirtualId.has(s.pageSlotId)) byVirtualId.set(s.pageSlotId, []);
        byVirtualId.get(s.pageSlotId)!.push(s);
      }
    }

    const toStroke = (s: typeof allStrokes[0]) => ({
      tool: s.tool,
      color: s.color,
      thickness: s.baseThickness,
      points: s.points.map(([x, y]) => [x, y] as [number, number]),
    });

    try {
      let savePath = viewerFile.path;
      if (byPage.size > 0 || docVirtualPages.length > 0) {
        const annotations = Array.from(byPage.entries()).map(([page, strokes]) => ({
          page,
          strokes: strokes.map(toStroke),
        }));
        const virtualPageData = docVirtualPages.map(vp => ({
          id: vp.id,
          template: vp.template,
          afterRealPage: vp.afterRealPage,
          strokes: (byVirtualId.get(vp.id) ?? []).filter(s => s.tool !== 'eraser').map(toStroke),
        }));
        savePath = await bakeAnnotations(viewerFile.path, annotations, virtualPageData);
      }
      await copyFile(savePath, originalViewerPath);
      evictPathFromThumbnailCache(originalViewerPath);
      // Don't clear strokes — they stay as overlay while thumbnails reload in the background
      setViewerFile({ ...viewerFile, path: originalViewerPath });
      setIsViewerDirty(false);
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleSaveAsAnnotations() {
    if (!viewerFile) return;
    setSaveError(null);
    const chosenPath = await showSaveDialog(viewerFile.path);
    if (!chosenPath) return;
    setSaveStatus("saving");

    const allStrokes = useNotesStore.getState().strokes[viewerFile.path] ?? [];
    const docVirtualPages = useNotesStore.getState().virtualPages[viewerFile.path] ?? [];

    const byPage = new Map<number, typeof allStrokes>();
    const byVirtualId = new Map<string, typeof allStrokes>();
    for (const s of allStrokes) {
      if (s.pageSlotId.startsWith('pdf-')) {
        const page = parseInt(s.pageSlotId.slice(4), 10);
        if (isNaN(page)) continue;
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(s);
      } else {
        if (!byVirtualId.has(s.pageSlotId)) byVirtualId.set(s.pageSlotId, []);
        byVirtualId.get(s.pageSlotId)!.push(s);
      }
    }

    const toStroke = (s: typeof allStrokes[0]) => ({
      tool: s.tool,
      color: s.color,
      thickness: s.baseThickness,
      points: s.points.map(([x, y]) => [x, y] as [number, number]),
    });

    try {
      let savePath = viewerFile.path;
      if (byPage.size > 0 || docVirtualPages.length > 0) {
        const annotations = Array.from(byPage.entries()).map(([page, strokes]) => ({
          page,
          strokes: strokes.map(toStroke),
        }));
        const virtualPageData = docVirtualPages.map(vp => ({
          id: vp.id,
          template: vp.template,
          afterRealPage: vp.afterRealPage,
          strokes: (byVirtualId.get(vp.id) ?? []).filter(s => s.tool !== 'eraser').map(toStroke),
        }));
        savePath = await bakeAnnotations(viewerFile.path, annotations, virtualPageData);
      }
      await copyFile(savePath, chosenPath);
      evictPathFromThumbnailCache(chosenPath);
      setViewerFile({ ...viewerFile, path: chosenPath });
      setOriginalViewerPath(chosenPath);
      setIsViewerDirty(false);
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: "var(--viewer-bg)", color: "var(--viewer-text)" }}
    >
      {/* Presentation mode fullscreen overlay */}
      {showPresentation && pageCount > 0 && (
        <PresentationMode
          path={viewerFile.path}
          pageCount={pageCount}
          startPage={currentPage}
          onClose={() => setShowPresentation(false)}
        />
      )}

      {/* Reading mode — floating exit button */}
      {readingMode && (
        <button
          onClick={() => setReadingMode(false)}
          title="Exit reading mode (Esc)"
          style={{
            position: "fixed", top: 12, right: 12, zIndex: 500,
            background: "var(--viewer-elevated)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6, padding: "5px 10px",
            color: "var(--viewer-text-muted)",
            fontSize: 11, fontFamily: "'Inter', system-ui, sans-serif",
            cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" viewBox="0 0 16 16">
            <path d="M12 4L4 12M4 4l8 8" />
          </svg>
          Exit reading
        </button>
      )}

      {/* Header — dense pro-tool toolbar */}
      <header
        style={{
          height: "calc(44px + env(safe-area-inset-top, 0px))",
          flexShrink: 0,
          background: "var(--viewer-surface)",
          borderBottom: "1px solid var(--viewer-border)",
          display: readingMode ? "none" : "flex", alignItems: "center",
          gap: 8,
          padding: "0 12px",
          paddingTop: "env(safe-area-inset-top, 0px)",
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

        {/* Annotation tool pills — hidden on small screens, accessible via the sidebar */}
        <div className="hidden sm:flex" style={{ gap: 1, padding: 2, border: "1px solid var(--viewer-border)", borderRadius: 4, flexShrink: 0 }}>
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

        {/* Save cluster — always visible */}
        <>
          <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            {saveStatus === "saving" && (
              <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, color: "var(--viewer-text-muted)" }}>
                saving…
              </span>
            )}
            {saveStatus === "saved" && (
              <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, color: "oklch(65% 0.16 145)" }}>
                ✓ saved
              </span>
            )}
            <button
              onClick={() => setAutoSave((a) => !a)}
              className="hidden sm:inline-flex items-center"
              title={autoSave ? "Auto-save on — click to disable" : "Auto-save off — click to enable"}
              style={{
                height: 20, padding: "0 7px", borderRadius: 10,
                border: `1px solid ${autoSave ? "var(--accent)" : "var(--viewer-border)"}`,
                background: autoSave ? "var(--accent-soft)" : "transparent",
                color: autoSave ? "var(--accent)" : "var(--viewer-text-muted)",
                fontSize: 10, fontWeight: 600, cursor: "pointer",
                fontFamily: "'Inter', system-ui, sans-serif",
                letterSpacing: "0.3px",
                transition: "background 120ms, color 120ms, border-color 120ms",
              }}
            >
              Auto
            </button>
            <button
              onClick={activeTool === "draw" ? handleSaveAnnotations : handleSave}
              disabled={saveStatus === "saving"}
              className={isViewerDirty ? "v-btn-primary-sm" : "v-btn-secondary-sm"}
              title="Save (Ctrl+S)"
              style={{ height: 26, padding: "0 10px", borderRadius: 4, fontSize: 11.5, fontWeight: isViewerDirty ? 600 : 400, display: "inline-flex", alignItems: "center" }}
            >
              Save
            </button>
            <button
              onClick={activeTool === "draw" ? handleSaveAsAnnotations : handleSaveAs}
              className="v-btn-secondary-sm hidden sm:inline-flex items-center"
              title="Save As (Ctrl+Shift+S)"
              style={{ height: 26, padding: "0 10px", borderRadius: 4, fontSize: 11.5 }}
            >
              Save As
            </button>
          </div>
        </>

        {/* Zoom — hidden on small screens (pinch-to-zoom replaces it) */}
        <div className="hidden sm:contents">
          <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />
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
        </div>

        {/* Page nav — hidden on small screens (scroll-to-navigate replaces it) */}
        {pageCount > 0 && (
          <div className="hidden sm:contents">
            <div style={{ width: 1, height: 18, background: "var(--viewer-border-sub)", flexShrink: 0 }} />
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
          </div>
        )}

        {/* Presentation mode */}
        {pageCount > 0 && (
          <button
            onClick={() => setShowPresentation(true)}
            className="v-icon-btn shrink-0"
            title="Present (fullscreen slideshow)"
            style={{ width: 28, height: 28, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </button>
        )}

        {/* Reading mode */}
        <button
          onClick={() => setReadingMode(r => !r)}
          className="v-icon-btn shrink-0"
          title="Reading mode — hide UI (Esc to exit)"
          style={{
            width: 28, height: 28, borderRadius: 4, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            color: readingMode ? "var(--accent)" : undefined,
          }}
        >
          <svg width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
        </button>

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
          ocrSearching={ocrSearching}
          ocrProgress={ocrProgress}
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

      {/* Annotation toolbar — shown when annotation mode is active */}
      {activeTool === "annotate" && (
        <AnnotationToolbar
          activeTool={activeAnnotTool}
          onToolChange={setActiveAnnotTool}
          onExit={() => handleToolChange(null)}
          activeColor={annotColor}
          onColorChange={setAnnotColor}
          currentPage={currentPage}
          pageCount={pageCount}
        />
      )}

      {/* Signature creation modal */}
      {showSignaturePanel && (
        <SignaturePanel
          onSignatureCreated={(dataUrl) => {
            setPendingSignature(dataUrl);
            setShowSignaturePanel(false);
          }}
          onClose={() => {
            setShowSignaturePanel(false);
            if (activeTool === "signature") handleToolChange(null);
          }}
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
        {/* Backdrop — dims content when a panel is open on mobile */}
        {(showStrip || (showTools && activeTool !== "draw")) && (
          <div
            className="absolute inset-0 z-10 sm:hidden"
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={() => { setShowStrip(false); setShowTools(false); }}
          />
        )}

        {/* Left: page strip — slide-in drawer on phone (with backdrop), fixed column on desktop */}
        {showStrip && !readingMode && (
          <div
            className="absolute inset-0 z-10 bg-black/40 sm:hidden"
            onClick={() => setShowStrip(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={`h-full shrink-0 flex-col ${
            showStrip && !readingMode
              ? "flex absolute inset-y-0 left-0 z-20 sm:relative sm:z-auto page-strip-drawer"
              : "hidden"
          }`}
          style={{
            paddingTop: showStrip && !readingMode ? "env(safe-area-inset-top, 0px)" : undefined,
            boxShadow: showStrip && !readingMode ? "6px 0 24px rgba(0,0,0,0.45)" : undefined,
          }}
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
            onReorder={async (fromPage, dropBeforePage) => {
              if (!viewerFile) return;
              const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
              const moved = pages.filter(p => p !== fromPage);
              const insertIdx = moved.findIndex(p => p === dropBeforePage);
              moved.splice(insertIdx === -1 ? moved.length : insertIdx, 0, fromPage);
              try {
                const out = await invoke<string>("reorder_pages", { path: viewerFile.path, order: moved });
                handleApplied(out);
              } catch { /* ignore */ }
            }}
          />
        </div>

        {/* Center: continuous scroll canvas */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto"
          style={{ background: "var(--viewer-canvas)", paddingBottom: "env(safe-area-inset-bottom, 0px)", position: "relative" }}
          onScroll={handleScroll}
        >
          <ScrollPageIndicator
            scrollContainerRef={scrollContainerRef}
            currentPage={currentPage}
            pageCount={pageCount}
          />
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

          {pageCount === 0 && loadError && (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              padding: "64px 32px", gap: 20, minHeight: 400,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "color-mix(in oklch, var(--v-bad-bg) 60%, transparent)",
                border: "1px solid var(--v-bad-border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width={24} height={24} fill="none" stroke="var(--v-bad-text)" strokeWidth={1.5}
                  strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  {loadError === "encrypted"
                    ? <><path d="M12 2C9.238 2 7 4.238 7 7v2H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2v-9a2 2 0 00-2-2h-2V7c0-2.762-2.238-5-5-5z" /><circle cx="12" cy="16" r="1" fill="currentColor" /></>
                    : <><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></>
                  }
                </svg>
              </div>
              <div style={{ textAlign: "center", maxWidth: 340 }}>
                <p style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 15, fontWeight: 600, color: "var(--viewer-text)", marginBottom: 6 }}>
                  {loadError === "encrypted" ? "Password protected" : "Cannot open this PDF"}
                </p>
                <p style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, color: "var(--viewer-text-sec)", lineHeight: 1.55 }}>
                  {loadError === "encrypted"
                    ? "This PDF is encrypted. Enter the password to unlock it, or use the Unlock tool."
                    : "This file may be corrupt, truncated, or not a valid PDF. Try re-downloading or opening it in another app."}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {loadError === "encrypted" && (
                  <button
                    onClick={() => handleToolChange("unlock")}
                    className="v-btn-primary"
                    style={{ fontSize: 13, padding: "7px 18px" }}
                  >
                    Unlock PDF…
                  </button>
                )}
                <button
                  onClick={doBack}
                  className="v-btn-secondary"
                  style={{ fontSize: 13, padding: "7px 18px" }}
                >
                  Back to library
                </button>
              </div>
            </div>
          )}

          {pageCount === 0 && !loadError && (
            <div
              aria-label="Loading document"
              aria-busy="true"
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "48px 32px", gap: 16,
              }}
            >
              {[1, 0.75, 0.55].map((w, i) => (
                <div key={i} style={{
                  width: `min(${Math.round(768 * w)}px, calc(100% - 64px))`,
                  height: i === 0 ? 520 : i === 1 ? 24 : 16,
                  borderRadius: 4,
                  background: "var(--viewer-elevated)",
                  border: "1px solid var(--viewer-border)",
                  animation: "pulse 1.6s ease-in-out infinite",
                  animationDelay: `${i * 120}ms`,
                }} />
              ))}
              <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>
            </div>
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
                        paddingLeft: SIDE_PAD,
                        paddingRight: SIDE_PAD,
                      }}
                    >
                      <div
                        className="relative"
                        data-page-index={page}
                        style={{
                          width: `${pageW}px`,
                          margin: "0 auto",
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
                          findActiveMatchOrdinal={
                            findOpen && findQuery.trim()
                              ? findActiveMatchOrdinalOnPage(page, findMatches, findCurrentIdx)
                              : -1
                          }
                          isDrawingMode={activeTool === "draw"}
                          enabled={shouldRenderTextLayer}
                        />
                        <LinkLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          isDrawingMode={activeTool === "draw"}
                          enabled={shouldRenderTextLayer}
                          onPageJump={scrollToPage}
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
                        <FormLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          zoom={zoom}
                          isEnabled={activeTool === "forms"}
                          onFieldChanged={setFieldValue}
                          filledFields={fieldValues}
                        />
                        <AnnotationLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          zoom={zoom}
                          isEnabled={activeTool === "annotate"}
                          activeAnnotTool={activeAnnotTool}
                          onAnnotationAdded={() => setAnnotRefreshKey(k => k + 1)}
                          key={`annot-${page}-${annotRefreshKey}`}
                        />
                        <SignatureLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          zoom={zoom}
                          isEnabled={activeTool === "signature"}
                          pendingSignature={pendingSignature}
                          onSignaturePlaced={(sig) => {
                            setSignatures(prev => [...prev, sig]);
                            setPendingSignature(null);
                          }}
                          onSignatureRemoved={(id) => setSignatures(prev => prev.filter(s => s.id !== id))}
                          signatures={signatures.filter(s => s.pageNum === page)}
                        />
                        <RedactLayer
                          pageNum={page}
                          isEnabled={activeTool === "redact"}
                          mode={redactMode}
                          regions={redactRegions}
                          onAddRegion={(r) => setRedactRegions(prev => [...prev, r])}
                          onAddRegions={(rs) => setRedactRegions(prev => [...prev, ...rs])}
                          onRemoveRegion={(idx) => setRedactRegions(prev => prev.filter((_, i) => i !== idx))}
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
                      paddingLeft: SIDE_PAD,
                      paddingRight: SIDE_PAD,
                    }}
                  >
                    <div
                      className="relative rounded shadow-2xl overflow-hidden"
                      style={{ width: `${pageW}px`, aspectRatio: `${pageW}/${pageH}`, margin: "0 auto" }}
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

        {/* Right: tool sidebar — full-screen overlay on mobile, fixed 280px column on desktop */}
        <div
          className={`h-full flex-col ${
            activeTool === "draw" || !showTools || readingMode
              ? "hidden"
              : "flex absolute inset-y-0 inset-x-0 z-20 sm:inset-x-auto sm:right-0 sm:relative sm:z-auto sm:w-70"
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
            currentPage={currentPage}
            forceCommentsTab={isCommentMode}
            redactRegions={redactRegions}
            onClearRedactRegions={() => setRedactRegions([])}
            redactMode={redactMode}
            onRedactModeChange={setRedactMode}
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
    <button onClick={onClick} disabled={disabled} title={title} className="v-header-btn">
      {children}
    </button>
  );
}

function AddPageBar({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="group flex items-center justify-center w-full" style={{ height: "28px", position: "relative" }}>
      <button
        onClick={onAdd}
        className="add-page-btn flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
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
