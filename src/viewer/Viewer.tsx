import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import { useNotesStore, PageTemplate, VirtualPage } from "../store/useNotesStore";

import { PageStrip } from "./PageStrip";
import { ToolSidebar, ViewerTool } from "./ToolSidebar";
import { invoke } from "@tauri-apps/api/core";
import { copyFile, showSaveDialog, bakeAnnotations, saveCompressedCopy, addPdfAnnotation, redactPdf } from "../lib/tauri";
import { loadSetting, Settings } from "../lib/settings";
import { triggerPrint } from "./tools/PrintPanel";
import { DrawingCanvas } from "./DrawingCanvas";
import { VirtualPageBackground } from "./VirtualPageBackground";
import { PageView } from "./PageView";
import { buildLayout, visibleRange, slotAt, anchorY, fitWidthZoom, snapToDevice, pageBoxLeft, PT_TO_CSS, PAGE_GAP, SIDE_PAD } from "../render/layout";
import { pagePx, renderScale } from "../render/tiles";
import { useDocInfo } from "../render/useDocInfo";
import { bumpDocVersion } from "../render/docVersion";
import { tileCache, tileKeyPrefix } from "../render/tileCache";
import { DrawToolbar } from "./tools/DrawToolbar";
import { TextLayer, evictTextPageCache } from "./TextLayer";
import { LinkLayer, evictLinkPageCache } from "./LinkLayer";
import { FindBar } from "./FindBar";
import { IcArrowLeft, IcClose, IcSearch } from "../components/Icons";
import { CommentLayer, CommentEditor } from "./CommentLayer";
import { FormLayer } from "./FormLayer";
import { SignatureLayer } from "./SignatureLayer";
import { RedactLayer } from "./RedactLayer";
import { SignaturePanel } from "./tools/SignaturePanel";
import { useFormFilling } from "./useFormFilling";
import { PresentationMode } from "./PresentationMode";
import { nextZoomFromWheel, snapZoom, commitZoom, clampZoom } from "./zoom";
import { useComments } from "./hooks/useComments";
import { useViewerUI } from "./hooks/useViewerUI";
import { useToolMode } from "./hooks/useToolMode";
import { useFindInDocument } from "./hooks/useFindInDocument";
import { useSignatures } from "./hooks/useSignatures";
import { useTextSelection, getSelectionGeometry } from "./hooks/useTextSelection";
import { useGoToPage } from "./hooks/useGoToPage";
import { useRedactRegions } from "./hooks/useRedactRegions";
import { useAutoSave } from "./hooks/useAutoSave";
// import { getPageOcrText } from "../lib/ocrEngine";

const EMPTY_VIRTUAL_PAGES: VirtualPage[] = [];
const EMPTY_SIGS: never[] = [];

// How long the wheel must be still before a zoom gesture commits — i.e. before the
// page boxes resize to the final zoom AND the high-res render is fetched. The smooth
// CSS transform preview covers this window, so a longer settle just means fast zoom-
// spam never fetches an intermediate resolution; it lands once. Tune to taste.
const ZOOM_COMMIT_SETTLE_MS = 400;

// Hard cap on how many pages get ACTIVE OPERATIONS (bitmap decode, text/link fetch,
// find highlights) around the current page. The page bitmaps are the only heavy memory,
// so capping to ±this bounds RAM regardless of zoom-out (which would otherwise fit
// dozens of pages on screen at once) and stops a fast scroll from loading everything it
// flies past. Pages beyond the band show a cheap placeholder until you scroll to them.
const MAX_LOADED_RADIUS = 3;

// Keep zone: pages within ±this of the current page stay MOUNTED once loaded — they keep
// their preview, but request no tiles (no IPC) outside the ±MAX_LOADED_RADIUS band. This
// stops load/unload thrash when scrolling back and forth. Beyond the keep zone pages
// unmount; their tiles stay in the byte-bounded tile cache until evicted.
const KEEP_RADIUS = 8;

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

export default function Viewer({ tabPath, isActive }: { tabPath: string; isActive: boolean }) {
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

  const [zoom, setZoom] = useState(1.0);
  // Always-fresh mirror of `zoom` for the wheel handler, which accumulates a
  // gesture's zoom in a ref and commits to React state only once it settles.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

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
    annotColor, setAnnotColor,
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

  // Group signatures by page once per change instead of running
  // signatures.filter() for every visible page on every render.
  const sigsByPage = useMemo(() => {
    const m = new Map<number, typeof signatures>();
    for (const s of signatures) {
      const arr = m.get(s.pageNum);
      if (arr) arr.push(s);
      else m.set(s.pageNum, [s]);
    }
    return m;
  }, [signatures]);

  // Form filling
  const { fieldValues, setFieldValue, saveFormFields: _saveFormFields, isDirty: _isFormDirty } = useFormFilling();

  // Comments (loads on mount, auto-saves on change). The comments themselves
  // are read by CommentLayer/sidebar via useCommentsStore. Save paths must
  // flushComments() first: the auto-save is debounced and a large PDF takes
  // seconds to rewrite, so "Saved ✓" without the flush can report success
  // while the comment write is still in flight (and dies with the process).
  const { flushComments, hasUnsavedComments } = useComments(viewerFile?.path);

  // Closing the window while a (slow, debounced) comment save is pending or
  // in flight would kill the write mid-parse and silently lose the comment —
  // exactly what happened with a 145 MB document. Hold the close, flush, then
  // close for real (second close passes because nothing is pending anymore).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let closing = false;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (closing || !hasUnsavedComments()) return;
          event.preventDefault();
          try {
            await flushComments();
          } catch (e) {
            console.error("[comments] flush on close failed:", e);
          }
          closing = true;
          getCurrentWindow().close();
        })
        .then((u) => { unlisten = u; })
        .catch(() => {});
    }).catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      return snapZoom(next);
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
  // Wraps all the absolutely-positioned page slots. During a zoom gesture we apply a
  // transient CSS `transform: scale()` here for an instant, smooth preview (no re-render,
  // no re-raster of pages); on settle we commit the real zoom and clear the transform.
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const [centerScrollTop, setCenterScrollTop] = useState(0);
  const [centerScrollLeft, setCenterScrollLeft] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const suppressScrollRef = useRef(false);

  // Fling detector. Every page that enters the virtual window mounts its full overlay
  // stack (text/link/comment/form/… layers), and TextLayer + LinkLayer each fire an IPC
  // fetch on mount — so flinging 0→50 mounts/unmounts ~50 heavy subtrees and queues ~100
  // IPC calls while the software compositor re-rasters the churning DOM every frame.
  // That transient pile was a multi-GB RAM spike (OOM risk on small machines). While a
  // fling is in progress we render canvas/placeholder ONLY; the overlay layers mount
  // once scrolling settles. Programmatic jumps (scrollToPage, zoom re-anchor) set
  // suppressScrollRef and never trip this.
  const [scrollSettled, setScrollSettled] = useState(true);
  const scrollSamplesRef = useRef<{ t: number; y: number }[]>([]);
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Width is kept stable by scrollbar-gutter; height is not, because a HORIZONTAL
    // scrollbar (which appears when a zoomed page overflows the width) shrinks the
    // content height by the scrollbar's thickness. Updating containerHeight on that
    // would fire a re-render + virtual-window recompute every time you cross fit-width.
    // So ignore height deltas within a scrollbar's thickness; real resizes are larger.
    let lastH = 0;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
        const h = entries[0].contentRect.height;
        if (Math.abs(h - lastH) > 24) { lastH = h; setContainerHeight(h); }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const BUFFER_SLOTS = 2;   // small buffer to avoid gaps when scrolling

  // Page sizes (every page, true size) + version; refetched when the file is rewritten.
  const docInfo = useDocInfo(viewerFile?.path);

  // Per-slot sizes: PDF slots use their page's real size; virtual (notes)
  // pages use page 1's size.
  const slotSizes = useMemo(() => {
    const pages = docInfo?.pages ?? [];
    const fallback = pages[0] ?? { w: 612, h: 792 };
    return pageSlots.map((s) => (s.type === "pdf" ? pages[s.pdfPage - 1] ?? fallback : fallback));
  }, [docInfo, pageSlots]);
  const layout = useMemo(() => buildLayout(slotSizes, zoom), [slotSizes, zoom]);
  // Read by the once-registered gesture/wheel handlers.
  const slotSizesRef = useRef(slotSizes);
  slotSizesRef.current = slotSizes;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const containerH = containerHeight || 600;
  const [firstSlot, lastSlot] = visibleRange(layout, centerScrollTop, containerH, BUFFER_SLOTS);
  const totalH = layout.totalH;

  // O(1) lookup: PDF page number → slot index, used by scrollToPage
  const pageToSlotIndex = useMemo(() => {
    const m = new Map<number, number>();
    pageSlots.forEach((slot, i) => { if (slot.type === 'pdf') m.set(slot.pdfPage, i); });
    return m;
  }, [pageSlots]);

  // Mount range = viewport window ∪ keep zone. Slots in the keep zone but outside the
  // viewport stay mounted (frozen — see KEEP_RADIUS); slots beyond both unmount and
  // free their canvas backing.
  const curSlotIdx = pageToSlotIndex.get(currentPage) ?? 0;
  const mountFirst = Math.max(0, Math.min(firstSlot, curSlotIdx - KEEP_RADIUS));
  const mountLast = Math.min(pageSlots.length - 1, Math.max(lastSlot, curSlotIdx + KEEP_RADIUS));

  // Device pixel ratio, tracked so moving the window to a monitor with a
  // different scale factor re-renders tiles at the new exact resolution.
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dpr]);

  // Anchor of the zoom gesture in content coords + its offset inside the viewport.
  // Captured at gesture start (wheel: cursor; pinch: midpoint); consumed by the commit
  // layout effect so the exact content point under the cursor/fingers stays put.
  const zoomAnchorRef = useRef<{ cx: number; cy: number; ox: number; oy: number } | null>(null);

  // On a committed zoom/layout change: clear the gesture preview transform and re-anchor
  // scroll so the gesture's anchor point (cursor / pinch midpoint, falling back to the
  // viewport centre for keyboard/toolbar zoom) stays on the same content — matching the
  // preview's transform-origin, so there is no jump at the preview→commit handoff.
  // useLayoutEffect so both happen BEFORE the browser paints the new layout — otherwise
  // the new (larger) layout would paint one frame with the stale preview transform = flash.
  // Vertical: the anchor keeps its relative position inside the same slot (anchorY);
  // horizontal page coords scale by the raw zoom ratio about the SIDE_PAD edge (the
  // browser clamps when there is no horizontal overflow).
  const prevZoomRef = useRef(zoom);
  const prevLayoutRef = useRef(layout);
  const prevContainerWidthRef = useRef(containerWidth);
  useLayoutEffect(() => {
    if (prevLayoutRef.current === layout && prevContainerWidthRef.current === containerWidth) return;
    const prevZoom = prevZoomRef.current;
    const prevLayout = prevLayoutRef.current;
    prevZoomRef.current = zoom;
    prevLayoutRef.current = layout;
    prevContainerWidthRef.current = containerWidth;
    // Clear the transient preview transform now that the real layout is at this zoom.
    if (contentWrapperRef.current) contentWrapperRef.current.style.transform = "";
    const container = scrollContainerRef.current;
    if (!container) return;
    const ratioH = prevZoom > 0 ? zoom / prevZoom : 1;
    const half = container.clientHeight / 2;
    const anchor = zoomAnchorRef.current ?? {
      cx: container.scrollLeft + container.clientWidth / 2,
      cy: container.scrollTop + half,
      ox: container.clientWidth / 2,
      oy: half,
    };
    zoomAnchorRef.current = null;
    const newSt = Math.max(0, anchorY(prevLayout, layout, anchor.cy) - anchor.oy);
    const newSl = Math.max(0, SIDE_PAD + (anchor.cx - SIDE_PAD) * ratioH - anchor.ox);
    suppressScrollRef.current = true;
    container.scrollTop = newSt;
    container.scrollLeft = newSl;
    setCenterScrollTop(newSt);
    setCenterScrollLeft(newSl);
    requestAnimationFrame(() => suppressScrollRef.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, containerWidth]);

  useEffect(() => {
    if (!viewerFile) navigate("/");
  }, [viewerFile]);


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

  useEffect(() => {
    if (viewerFile && !isViewerDirty) {
      setOriginalViewerPath(viewerFile.path);
    }
  }, []);

  // Zoom gesture controller: ctrl+wheel (non-passive on window so WebView2 native zoom
  // is blocked) and two-finger pinch share one preview/commit pipeline.
  //
  // Wheel events fire far faster than the screen refreshes (60–120+/sec on a trackpad).
  // Calling setZoom on every one floods React with full re-renders faster than the
  // WebView can drain them. Instead the gesture drives a transient CSS transform preview
  // (instant, anchored on the cursor / pinch midpoint, re-renders nothing) and commits
  // ONE snapped zoom once the gesture settles; the layout effect above then re-anchors
  // scroll to the same anchor point, so the content under the cursor never moves.
  useEffect(() => {
    let accumDelta = 0;
    let raf: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // Continuous gesture zoom — drives the smooth CSS preview every frame. The
    // committed (React-state) zoom only changes on settle, and is snapped to the
    // ladder so the render cache sees only a handful of distinct scales.
    let previewZoom: number | null = null;
    // Preview transform origin in content coords, captured once per gesture.
    let originX = 0, originY = 0;
    // Where the wheel cursor was (viewport coords) — anchor for the next gesture.
    let lastClientX = 0, lastClientY = 0;
    // Pinch state.
    let lastDist = 0;

    // Capture the gesture anchor: the content point under (clientX, clientY) plus its
    // offset inside the viewport. The preview scales about it; the commit layout effect
    // consumes zoomAnchorRef to pin the same point after the real layout lands.
    function captureAnchor(clientX: number, clientY: number) {
      const container = scrollContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ox = clientX - rect.left;
      const oy = clientY - rect.top;
      originX = container.scrollLeft + ox;
      originY = container.scrollTop + oy;
      zoomAnchorRef.current = { cx: originX, cy: originY, ox, oy };
    }
    function applyPreview() {
      const wrapper = contentWrapperRef.current;
      if (!wrapper || previewZoom == null) return;
      // Scale the page slots relative to the CURRENT committed layout. This is a pure
      // composite transform — instant, smooth, and it re-renders NOTHING, so a fast
      // zoom-spam never decodes a page or spikes RAM mid-gesture.
      wrapper.style.transformOrigin = `${originX}px ${originY}px`;
      wrapper.style.transform = `scale(${previewZoom / zoomRef.current})`;
    }
    function scheduleCommit() {
      // Commit (and thus fetch the high-res render) only once the gesture has been
      // still for a beat. The transform preview covers this gap, so fast zoom-spam
      // never fetches an intermediate resolution — only the zoom you land on.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(commit, ZOOM_COMMIT_SETTLE_MS);
    }
    function commit() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (previewZoom == null) return;
      const container = scrollContainerRef.current;
      const cw = container ? container.clientWidth : window.innerWidth;
      const fitZoom = fitWidthZoom(slotSizesRef.current, cw);
      // Snap on commit (fit-width magnet exempt so it stays exactly landable). The
      // layout effect then clears the transform + re-anchors, pre-paint.
      const committed = commitZoom(previewZoom, zoomRef.current, fitZoom);
      previewZoom = null;
      if (committed === zoomRef.current) {
        // No layout change is coming (e.g. pinned at the zoom limit), so the layout
        // effect won't run: drop the preview transform here or it blurs every tile.
        const wrapper = contentWrapperRef.current;
        if (wrapper) wrapper.style.transform = "";
        zoomAnchorRef.current = null;
        return;
      }
      setZoom(committed);
    }

    // ── ctrl+wheel ──
    function flush() {
      raf = null;
      const delta = accumDelta;
      accumDelta = 0;
      if (delta === 0) return;
      const container = scrollContainerRef.current;
      const cw = container ? container.clientWidth : window.innerWidth;
      // fitZoom = zoom at which the widest page exactly fills the container
      const fitZoom = fitWidthZoom(slotSizesRef.current, cw);
      const wasIdle = previewZoom == null;
      const base = previewZoom ?? zoomRef.current;
      // Continuous (un-snapped) so the preview is buttery; snapping happens at commit.
      previewZoom = nextZoomFromWheel(base, delta, fitZoom);
      if (wasIdle) captureAnchor(lastClientX, lastClientY);
      applyPreview();
      scheduleCommit();
    }
    function onWheel(e: WheelEvent) {
      // Hidden tabs stay mounted; only the visible one reacts to the wheel.
      if (!isActiveRef.current) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        accumDelta += e.deltaY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        if (raf == null) raf = requestAnimationFrame(flush);
      }
    }

    // ── two-finger pinch ──
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
      const wasIdle = previewZoom == null;
      const base = previewZoom ?? zoomRef.current;
      // Continuous, like the wheel — the old per-move snap+commit re-laid-out the page
      // mid-gesture; now the fingers drive the preview and the commit lands on release.
      previewZoom = clampZoom(base * factor);
      if (wasIdle) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        captureAnchor((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      }
      applyPreview();
      scheduleCommit();
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length >= 2) return;
      lastDist = 0;
      // Fingers lifted — commit immediately rather than waiting out the settle timer.
      commit();
    }

    const el = scrollContainerRef.current;
    window.addEventListener("wheel", onWheel, { passive: false });
    el?.addEventListener("touchstart", onTouchStart, { passive: true });
    el?.addEventListener("touchmove", onTouchMove, { passive: false });
    el?.addEventListener("touchend", onTouchEnd, { passive: true });
    el?.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      el?.removeEventListener("touchstart", onTouchStart);
      el?.removeEventListener("touchmove", onTouchMove);
      el?.removeEventListener("touchend", onTouchEnd);
      el?.removeEventListener("touchcancel", onTouchEnd);
      if (raf != null) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
    };
  // scrollContainerRef.current is stable after mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fit zoom on small screens so the PDF isn't wider than the viewport
  // (needs the page sizes, so it runs once they arrive).
  useEffect(() => {
    if (window.innerWidth >= 640 || !docInfo) return;
    setZoom(Math.max(0.25, Math.min(1.0, fitWidthZoom(slotSizes, window.innerWidth))));
  // Run once per document load, not on every zoom-driven slotSizes identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docInfo]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isActive) return; // hidden tabs ignore the keyboard
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
  }, [isActive, isViewerDirty, confirmingBack, findOpen, currentPage, pageCount, viewerFile, undoViewerFile, originalViewerPath, zoom, activeTool, undoStroke, readingMode, showPresentation]);

  // Hidden tab: free its tiles (previews stay); they re-render on return.
  useEffect(() => {
    if (!isActive && viewerFile?.path) tileCache.dropPrefix(tileKeyPrefix(viewerFile.path));
  }, [isActive, viewerFile?.path]);

  if (!viewerFile) return null;

  // A path's rendered tiles are no longer needed (swapped away after an edit).
  function dropDocTiles(path: string) {
    tileCache.dropPrefix(tileKeyPrefix(path));
  }

  // The file at `path` was rewritten on disk: drop everything rendered from it.
  function evictDocRenders(path: string) {
    dropDocTiles(path);
    bumpDocVersion(path); // refetch page info + every thumbnail of this file
    evictTextPageCache(path);
    evictLinkPageCache(path);
  }

  // Slot i's page box in content CSS px: sized to whole device pixels and placed
  // on the device-pixel grid, so tiles land 1:1 on screen.
  const pageBox = (i: number) => {
    const size = slotSizes[i] ?? { w: 612, h: 792 };
    const w = pagePx(size, renderScale(zoom, dpr)).w / dpr;
    return {
      top: snapToDevice((layout.tops[i] ?? 0) + PAGE_GAP / 2, dpr),
      left: pageBoxLeft(containerWidth, w, dpr),
      w,
    };
  };

  // Visible part of slot i's page box, in that box's CSS px.
  const pageVisibleCss = (i: number) => {
    const { top: boxTop, left: boxLeft } = pageBox(i);
    return {
      x0: centerScrollLeft - boxLeft,
      y0: centerScrollTop - boxTop,
      x1: centerScrollLeft - boxLeft + containerWidth,
      y1: centerScrollTop - boxTop + containerH,
    };
  };

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
    if (suppressScrollRef.current) return;
    const st = container.scrollTop;
    setCenterScrollTop(st);
    setCenterScrollLeft(container.scrollLeft);

    // Fling detection: distance covered in the last ~150ms exceeding a viewport-height
    // means the user is flying past pages, not reading — strip the overlay layers.
    const now = performance.now();
    const samples = scrollSamplesRef.current;
    samples.push({ t: now, y: st });
    while (samples.length > 0 && now - samples[0]!.t > 150) samples.shift();
    const dist = Math.abs(st - samples[0]!.y);
    const h = containerHeight || 600;
    // >1 viewport in 150ms = flinging. Settled comes back ONLY via the quiet timer
    // below — an early speed-based re-entry flapped during fling deceleration, firing
    // band decodes + layer mounts for every intermediate position (multi-GB transient)
    // and cancelling first decodes mid-flight (stuck spinners).
    if (dist > h && scrollSettled) setScrollSettled(false);
    if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
    scrollSettleTimerRef.current = setTimeout(() => {
      scrollSettleTimerRef.current = null;
      scrollSamplesRef.current = [];
      setScrollSettled(true);
    }, 180);

    // Derive current page from scroll position — O(1), no DOM queries
    const rawIdx = slotAt(layout, st + (containerHeight || 600) / 3);
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
    const newSt = layout.tops[idx] ?? 0;
    suppressScrollRef.current = true;
    container.scrollTop = newSt;
    setCenterScrollTop(newSt);
    requestAnimationFrame(() => suppressScrollRef.current = false);
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
    const vf = store.tabFiles[tabPath] ?? store.openTabs.find(t => t.path === tabPath) ?? null;
    const origPath = store.tabOriginal[tabPath] ?? null;
    const isDirty = store.tabDirty[tabPath] ?? false;
    if (!vf) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      // Pending comment writes go into vf.path — land them before copying.
      await flushComments();
      if (!origPath) {
        const chosenPath = await showSaveDialog(vf.path);
        if (!chosenPath) { setSaveStatus("idle"); return; }
        await copyFile(vf.path, chosenPath);
        evictDocRenders(chosenPath);
        store.setTabFile(tabPath, { ...vf, path: chosenPath, name: chosenPath.split(/[\\/]/).pop() ?? chosenPath });
        store.setTabOriginal(tabPath, chosenPath);
        store.setTabDirty(tabPath, false);
      } else if (isDirty) {
        await copyFile(vf.path, origPath);
        evictDocRenders(origPath);
        store.setTabFile(tabPath, { ...vf, path: origPath, name: origPath.split(/[\\/]/).pop() ?? origPath });
        store.setTabDirty(tabPath, false);
      }
      markSaved();
    } catch (e) {
      setSaveStatus("error");
      setSaveError(friendlySaveError(e));
    }
  }

  async function handleApplied(path: string, opts?: { saveAsNew?: boolean }) {
    const prevPath = viewerFile?.path;

    // Compress: save the result as a NEW file beside the original (never
    // overwrite), then open it as a clean, saved document — no "unsaved" limbo.
    if (opts?.saveAsNew) {
      const base = originalViewerPath ?? prevPath ?? path;
      try {
        const dest = await saveCompressedCopy(path, base);
        setUndoViewerFile(viewerFile); // Ctrl+Z → back to the pre-compress doc
        handleOpenFile(dest);
        setOriginalViewerPath(dest); // the new file is its own document
        setIsViewerDirty(false);
        markSaved();
        if (prevPath && prevPath !== dest) dropDocTiles(prevPath);
        return;
      } catch (e) {
        // Couldn't place the file (e.g. no real path on Android) — fall back to
        // opening the result as an unsaved edit so it isn't lost.
        setSaveStatus("error");
        setSaveError(friendlySaveError(e));
      }
    }

    setUndoViewerFile(viewerFile); // snapshot for Ctrl+Z
    handleOpenFile(path);
    setIsViewerDirty(true);
    // Free the superseded document's in-memory bitmaps now — the viewer has
    // moved to `path`, so the old file's rendered pages just waste WebView heap.
    // (Undo re-renders them lazily; disk/session caches keep that cheap.)
    if (prevPath && prevPath !== path) dropDocTiles(prevPath);
    if (autoSaveRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = window.setTimeout(triggerAutoSave, 1500);
    }
  }

  // --- Selection popup actions -------------------------------------------
  const selPopupBtn: import("react").CSSProperties = {
    background: "transparent", border: "none", color: "var(--viewer-text)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 5, borderRadius: 5, cursor: "pointer",
  };

  function clearSelection() {
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
  }

  // Swap the viewer to an edited file IN PLACE, keeping scroll/zoom by NOT routing
  // through handleApplied (which resets to page 1). Only the visible pages' tiles
  // re-render for the new path; the old path's tiles are freed.
  function swapInPlaceAfterEdit(
    vf: NonNullable<typeof viewerFile>,
    oldPath: string,
    newPath: string,
  ) {
    setUndoViewerFile(vf); // Ctrl+Z snapshot
    setViewerFile({ ...vf, path: newPath });
    setIsViewerDirty(true);
    if (oldPath !== newPath) dropDocTiles(oldPath);
    if (autoSaveRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = window.setTimeout(triggerAutoSave, 1500);
    }
  }

  // Apply a text-markup annotation to the live selection. One add_pdf_annotation
  // call per page the selection touches.
  // ponytail: O(pages) full file rewrites — fine for popup-sized selections; add
  // a batch backend command if multi-page markup ever becomes a hot path.
  async function applyMarkup(subtype: "Highlight" | "Underline" | "StrikeOut") {
    const vf = viewerFile;
    if (!vf) return;
    const geom = getSelectionGeometry();
    clearSelection();
    if (!geom.length) return;
    try {
      const oldPath = vf.path;
      let path = oldPath;
      for (const g of geom) {
        const quad_points = g.lines.flatMap((l) => [l.x0, l.y0, l.x1, l.y0, l.x0, l.y1, l.x1, l.y1]);
        path = await addPdfAnnotation(path, {
          subtype,
          page: g.page,
          rect: [g.bbox.x0, g.bbox.y0, g.bbox.x1, g.bbox.y1],
          color: annotColor,
          quad_points,
        });
      }
      swapInPlaceAfterEdit(vf, oldPath, path);
    } catch { /* error surfaces via the dirty-state UI on next save */ }
  }

  // Redact the selected lines. Destructive + immediate: redact_pdf permanently
  // destroys the underlying content and bakes a black rectangle, so the result is
  // already part of the working file (a plain save persists it) — staging an
  // overlay region instead would vanish on save.
  async function applyRedactFromSelection() {
    const vf = viewerFile;
    if (!vf) return;
    const geom = getSelectionGeometry();
    clearSelection();
    if (!geom.length) return;
    const regions = geom.flatMap((g) =>
      g.lines.map((l) => ({ page: g.page, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }))
    );
    try {
      const out = await redactPdf(vf.path, regions);
      swapInPlaceAfterEdit(vf, vf.path, out);
    } catch { /* error surfaces via the dirty-state UI on next save */ }
  }

  function copySelection() {
    const text = selectionPopup?.text ?? "";
    clearSelection();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
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
    if (!isViewerDirty && !hasUnsavedComments()) { markSaved(); return; }
    setSaveError(null);
    setSaveStatus("saving");
    try {
      // Comments save on a debounce into the working file — force the write
      // and wait, or "Saved ✓" lies while it is still in flight.
      await flushComments();
      if (isViewerDirty) {
        await copyFile(viewerFile.path, originalViewerPath);
        evictDocRenders(originalViewerPath);
        setViewerFile({ ...viewerFile, path: originalViewerPath, name: originalViewerPath.split(/[\\/]/).pop() ?? originalViewerPath });
        setIsViewerDirty(false);
      }
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
      // Land any pending comment write in the source before copying it.
      await flushComments();
      await copyFile(viewerFile.path, chosenPath);
      evictDocRenders(chosenPath);
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
      // Pending comment writes must land in the file before it gets baked
      // and copied over the original.
      await flushComments();
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
      const needConfirm = await loadSetting(Settings.confirmBeforeOverwrite);
      if (needConfirm && !confirm(`Overwrite "${viewerFile.name}" with your changes?`)) {
        setSaveStatus("idle");
        return;
      }
      await copyFile(savePath, originalViewerPath);
      evictDocRenders(originalViewerPath);
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
      // Pending comment writes must land in the file before bake/copy.
      await flushComments();
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
      evictDocRenders(chosenPath);
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
          className="btn-secondary btn-sm"
          style={{ position: "fixed", top: 12, right: 12, zIndex: 500, boxShadow: "var(--shadow-pop)" }}
        >
          <IcClose size={14} />
          Exit reading
        </button>
      )}

      {/* Toolbar — the kiri-wood counter above the page */}
      <header className="toolbar" style={{ display: readingMode ? "none" : undefined }}>
        <button onClick={handleBack} className="btn-ghost" title="Back to library">
          <IcArrowLeft size={16} />
          Library
        </button>

        <div className="toolbar-title">
          <span className="toolbar-name" title={displayName}>{displayName}</span>
          {viewerFile.info && (
            <span className="t-meta">
              {viewerFile.info.page_count} {viewerFile.info.page_count === 1 ? "page" : "pages"}
              {isViewerDirty && <span className="toolbar-dirty"> · unsaved</span>}
            </span>
          )}
        </div>

        <div className="seg" role="group" aria-label="Markup">
          {(["Highlight", "Comment", "Sign"] as const).map((t) => {
            const on = activeAnnot === t && (activeTool === "draw" || activeTool === "comment");
            return (
              <button
                key={t}
                type="button"
                className="seg-item"
                aria-pressed={on}
                onClick={() => {
                  const targetTool = t === "Comment" ? "comment" : "draw";
                  if (activeTool === targetTool && activeAnnot === t) {
                    handleToolChange(null);
                  } else {
                    setActiveAnnot(t);
                    handleToolChange(targetTool);
                  }
                }}
              >{t}</button>
            );
          })}
        </div>

        <span className="toolbar-sep" />

        <button
          onClick={() => setFindOpen((o) => !o)}
          className="btn-icon"
          aria-pressed={findOpen}
          title="Find in document (Ctrl+F)"
        >
          <IcSearch size={16} />
        </button>

        <div className="toolbar-group" role="group" aria-label="Zoom">
          <button className="btn-icon" onClick={() => adjustZoom(-0.25)} disabled={zoom <= 0.25} title="Zoom out (Ctrl+-)">
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" viewBox="0 0 16 16"><path d="M3 8h10" /></svg>
          </button>
          <button className="btn-ghost toolbar-num" onClick={() => setZoom(1.0)} title="Reset zoom (Ctrl+0)">
            {Math.round(zoom * 100)}%
          </button>
          <button className="btn-icon" onClick={() => adjustZoom(0.25)} disabled={zoom >= 3.0} title="Zoom in (Ctrl+=)">
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>
          </button>
        </div>

        {pageCount > 0 && (
          <>
            <span className="toolbar-sep" />
            <div className="toolbar-group" role="group" aria-label="Page">
              <button className="btn-icon" onClick={() => currentPage > 1 && scrollToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page">
                <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
                  strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" /></svg>
              </button>
              {editingPage ? (
                <input
                  type="number" min={1} max={pageCount} value={pageInputValue} autoFocus
                  className="input toolbar-page-input"
                  aria-label="Go to page"
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
                  className="btn-ghost toolbar-num"
                  onClick={() => { setPageInputValue(String(currentPage)); setEditingPage(true); }}
                  title="Go to page"
                >
                  {currentPage}<span className="toolbar-of"> / {pageCount}</span>
                </button>
              )}
              <button className="btn-icon" onClick={() => currentPage < pageCount && scrollToPage(currentPage + 1)} disabled={currentPage >= pageCount} title="Next page">
                <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
                  strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
              </button>
            </div>
          </>
        )}

        <span style={{ flex: 1 }} />

        {undoViewerFile && (
          <button
            onClick={() => {
              setViewerFile(undoViewerFile);
              setUndoViewerFile(null);
              setIsViewerDirty(undoViewerFile.path !== (originalViewerPath ?? ""));
              setCurrentPage(1);
            }}
            className="btn-ghost"
            title="Undo last operation (Ctrl+Z)"
          >
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            Undo
          </button>
        )}

        <div className="toolbar-group">
          {saveStatus === "saving" && <span className="t-meta">Saving…</span>}
          {saveStatus === "saved" && <span className="t-meta" style={{ color: "var(--ok)" }}>Saved</span>}
          <button
            onClick={() => setAutoSave((a) => !a)}
            className="btn-ghost btn-sm"
            aria-pressed={autoSave}
            title={autoSave ? "Auto-save is on. Click to turn it off." : "Auto-save is off. Click to turn it on."}
          >
            Auto-save
          </button>
          <button
            onClick={activeTool === "draw" ? handleSaveAnnotations : handleSave}
            disabled={saveStatus === "saving"}
            className={isViewerDirty ? "btn-primary" : "btn-secondary"}
            title="Save (Ctrl+S)"
          >
            Save
          </button>
          <button
            onClick={activeTool === "draw" ? handleSaveAsAnnotations : handleSaveAs}
            className="btn-ghost"
            title="Save as… (Ctrl+Shift+S)"
          >
            Save as…
          </button>
        </div>

        <span className="toolbar-sep" />

        <div className="toolbar-group">
          {pageCount > 0 && (
            <button onClick={() => setShowPresentation(true)} className="btn-icon" title="Present (fullscreen slideshow)">
              <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
                strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
            </button>
          )}
          <button onClick={() => setReadingMode(r => !r)} className="btn-icon" aria-pressed={readingMode} title="Reading mode: hide the chrome (Esc to exit)">
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </button>
          <button onClick={() => setShowStrip(s => !s)} className="btn-icon" aria-pressed={showStrip} title="Show or hide the page strip">
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
              <rect x="2.5" y="3" width="4" height="10" rx="0.5" /><rect x="9.5" y="3" width="4" height="10" rx="0.5" />
            </svg>
          </button>
          <button onClick={() => setShowTools(t => !t)} className="btn-icon" aria-pressed={showTools} title="Show or hide the tools">
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16">
              <rect x="2.5" y="3" width="11" height="10" rx="0.5" /><path d="M9.5 3v10M11 6h1M11 8h1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Discard-changes confirmation overlay */}
      {confirmingBack && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "oklch(0.15 0.03 265 / 0.45)" }}
          onClick={() => setConfirmingBack(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="discard-title"
            className="pop"
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", padding: "var(--space-6)", width: 360, boxShadow: "var(--shadow-dialog)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <p id="discard-title" className="t-title" style={{ margin: 0 }}>Discard unsaved changes?</p>
              <p style={{ margin: "var(--space-2) 0 0", color: "var(--fg1)" }}>
                Your changes to this sheet will be lost. This cannot be undone.
              </p>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmingBack(false)} className="btn-secondary" autoFocus>
                Keep editing
              </button>
              <button onClick={doBack} className="btn-danger">
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save error banner */}
      {saveError && (
        <div role="alert" className="alert" style={{ borderRadius: 0, borderWidth: "0 0 1px", flexShrink: 0 }}>
          <span style={{ flex: 1 }}>Save failed: {saveError}</span>
          <button onClick={() => setSaveError(null)} className="btn-ghost btn-sm" style={{ color: "inherit" }}>
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

      {/* Selection Popup Tooltip — inline quick-access markup menu */}
      {selectionPopup && !selectionEditor && (
        <div
          className="pop"
          style={{
            position: "fixed",
            left: selectionPopup.rect.left + selectionPopup.rect.width / 2,
            top: selectionPopup.rect.top - 46,
            transform: "translateX(-50%)",
            zIndex: 1000,
            padding: "4px 6px",
            display: "flex",
            alignItems: "center",
            gap: 3,
            maxWidth: "92vw",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
          onMouseDown={(e) => e.preventDefault()} // keep the selection alive
        >
          {/* Color swatches — pick the markup color */}
          {["#000000", "#2563eb", "#16a34a", "#dc2626", "#ffffff"].map((c) => (
            <button
              key={c}
              onClick={() => setAnnotColor(c)}
              title={`Color ${c}`}
              style={{
                width: 16, height: 16, borderRadius: "50%", background: c,
                border: "1px solid var(--viewer-border)", cursor: "pointer", flexShrink: 0,
                outline: annotColor === c ? "2px solid var(--accent)" : "2px solid transparent",
                outlineOffset: 1,
              }}
            />
          ))}
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--viewer-border)", margin: "0 2px" }} />

          {/* Markup actions — applied in the selected color */}
          <button onClick={() => applyMarkup("Highlight")} title="Highlight" style={selPopupBtn}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.2 5.2l3.6 3.6M9 13l-4 4 1 3 3-1 4-4M16.5 6.5l-7 7" />
            </svg>
          </button>
          <button onClick={() => applyMarkup("Underline")} title="Underline" style={selPopupBtn}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 5v6a5 5 0 0010 0V5M5 21h14" />
            </svg>
          </button>
          <button onClick={() => applyMarkup("StrikeOut")} title="Strikeout" style={selPopupBtn}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M8 7h8M9 17h6" />
            </svg>
          </button>
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--viewer-border)", margin: "0 2px" }} />

          <button onClick={applyRedactFromSelection} title="Redact" style={selPopupBtn}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x={4} y={9} width={16} height={6} rx={1} fill="currentColor" />
            </svg>
          </button>
          <button onClick={copySelection} title="Copy" style={selPopupBtn}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <rect x={9} y={9} width={11} height={11} rx={2} strokeLinejoin="round" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15V5a2 2 0 012-2h8" />
            </svg>
          </button>
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
            title="Add comment"
            style={selPopupBtn}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
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
        {/* Left: page strip */}
        <div className={`h-full shrink-0 flex-col ${showStrip && !readingMode ? "flex" : "hidden"}`}>
          <PageStrip
            path={viewerFile.path}
            version={docInfo?.version}
            pageCount={pageCount}
            currentPage={currentPage}
            onPageSelect={scrollToPage}
            selectionMode={activeTool === "remove"}
            selectedPages={selectedPages}
            onPageToggle={handlePageToggle}
            splitAfter={activeTool === "split" ? splitAfter : undefined}
            onSplitAfterChange={activeTool === "split" ? setSplitAfter : undefined}
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
          // scrollbar-gutter: stable reserves the vertical scrollbar's space so it
          // appearing/disappearing never resizes the content → no ResizeObserver churn /
          // re-render on (zoom) overflow.
          style={{ background: "var(--viewer-canvas)", paddingBottom: "env(safe-area-inset-bottom, 0px)", position: "relative", scrollbarGutter: "stable" }}
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
              <div style={{ textAlign: "center", maxWidth: 360 }}>
                <p className="t-title" style={{ margin: "0 0 var(--space-2)" }}>
                  {loadError === "encrypted" ? "This PDF is password protected" : "This PDF cannot be opened"}
                </p>
                <p style={{ margin: 0, color: "var(--fg1)" }}>
                  {loadError === "encrypted"
                    ? "Enter its password with the Unlock tool to read it."
                    : "The file may be damaged, cut short, or not a PDF at all. Try the Repair tool, or download it again."}
                </p>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                {loadError === "encrypted" && (
                  <button onClick={() => handleToolChange("unlock")} className="btn-primary">
                    Unlock PDF…
                  </button>
                )}
                <button onClick={doBack} className="btn-secondary">
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
                  width: `min(${Math.round((docInfo?.pages[0]?.w ?? 612) * PT_TO_CSS * w)}px, calc(100% - 64px))`,
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
          <div ref={contentWrapperRef} style={{ position: "relative", height: totalH }}>

            {/* Add-page bar before first page (draw mode) */}
            {activeTool === "draw" && pageSlots.length > 0 && (
              <div style={{ position: "absolute", top: 4, left: SIDE_PAD, right: SIDE_PAD }}>
                <AddPageBar onAdd={() => setAddPageAt(0)} />
              </div>
            )}

            {pageSlots.slice(mountFirst, mountLast + 1).map((slot, i) => {
              const slotIndex = mountFirst + i;
              const topPos = layout.tops[slotIndex] ?? 0;
              const slotH = layout.slotHeights[slotIndex] ?? 0;
              const sizePt = slotSizes[slotIndex] ?? { w: 612, h: 792 };

              if (slot.type === 'pdf') {
                const page = slot.pdfPage;
                const box = pageBox(slotIndex);
                const isSelected = activeTool === "remove" && selectedPages.has(page);
                const shouldRenderTextLayer = true; // all visible pages (virtual scroll limits active pages)
                return (
                  <React.Fragment key={slot.slotId}>
                    <div
                      style={{
                        position: "absolute",
                        top: box.top,
                        left: 0,
                        right: 0,
                        paddingRight: SIDE_PAD,
                      }}
                    >
                      {/* Page box at the page's true size × zoom. PageView shows a lossless
                          preview immediately and lays exact-device-pixel tiles over it; tiles are
                          only requested for the active tab, once scrolling settles, within the
                          ±MAX_LOADED_RADIUS band. Overlays keep using inset:0 of this box. */}
                      <div
                        data-page-index={page}
                        style={{ width: `${box.w}px`, marginLeft: `${box.left}px` }}
                        onClick={activeTool === "remove" ? () => handlePageToggle(page) : undefined}
                      >
                      <PageView
                        path={viewerFile.path}
                        version={docInfo?.version ?? ""}
                        page={page}
                        sizePt={sizePt}
                        zoom={zoom}
                        dpr={dpr}
                        visibleCss={
                          docInfo && isActive && scrollSettled && Math.abs(page - currentPage) <= MAX_LOADED_RADIUS
                            ? pageVisibleCss(slotIndex)
                            : null
                        }
                        className="rounded"
                        style={{ cursor: activeTool === "remove" ? "pointer" : undefined }}
                      >
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
                        {/* Overlay stack mounts only for pages in the active band AND once
                            scrolling settles. Keep-zone pages are frozen: their canvas frame
                            stays, but no layer subtree (and no mount-time IPC) runs on them.
                            During a fling these subtrees would churn for every page flying
                            past — the source of the fast-scroll RAM spike. */}
                        {scrollSettled && Math.abs(page - currentPage) <= MAX_LOADED_RADIUS && <>
                        <TextLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          findQuery={findOpen ? findQuery : undefined}
                          findActiveMatchOrdinal={
                            findOpen && findQuery.trim()
                              ? findActiveMatchOrdinalOnPage(page, findMatches, findCurrentIdx)
                              : -1
                          }
                          isDrawingMode={activeTool === "draw"}
                          enabled={shouldRenderTextLayer}
                          selectable={activeTool === null}
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
                        />
                        <CommentLayer
                          pageIndex={page}
                          docPath={viewerFile.path}
                          isCommentMode={isCommentMode}
                        />
                        <FormLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          isEnabled={activeTool === "forms"}
                          onFieldChanged={setFieldValue}
                          filledFields={fieldValues}
                        />
                        <SignatureLayer
                          pdfPath={viewerFile.path}
                          pageNum={page}
                          isEnabled={activeTool === "signature"}
                          pendingSignature={pendingSignature}
                          onSignaturePlaced={(sig) => {
                            setSignatures(prev => [...prev, sig]);
                            setPendingSignature(null);
                          }}
                          onSignatureRemoved={(id) => setSignatures(prev => prev.filter(s => s.id !== id))}
                          signatures={sigsByPage.get(page) ?? EMPTY_SIGS}
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
                        </>}
                      </PageView>
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
                const pageW = layout.widths[slotIndex] ?? 0;
                const pageH = layout.heights[slotIndex] ?? 0;
                // Unzoomed CSS size; the SVG is drawn at this size and scaled by zoom.
                const baseW = Math.round(sizePt.w * PT_TO_CSS);
                const baseH = Math.round(sizePt.h * PT_TO_CSS);
                return (
                  <div
                    key={slot.slotId}
                    style={{
                      position: "absolute",
                      top: topPos + PAGE_GAP / 2,
                      left: 0,
                      right: 0,
                      paddingLeft: SIDE_PAD,
                      paddingRight: SIDE_PAD,
                    }}
                  >
                    {/* Virtual pages are lightweight vector (SVG) with no page bitmap, so the
                        canvas tile-pyramid that forced the PDF-page rework doesn't apply here.
                        A plain transform:scale of fixed-size SVG is cheap and crisp at any zoom. */}
                    <div style={{ width: `${pageW}px`, height: `${pageH}px`, margin: "0 auto" }}>
                    <div
                      className="relative rounded shadow-2xl overflow-hidden"
                      style={{
                        width: `${baseW}px`,
                        height: `${baseH}px`,
                        transform: `scale(${zoom})`,
                        transformOrigin: "top left",
                      }}
                    >
                      <VirtualPageBackground template={vp.template} width={baseW} height={baseH} />
                      <DrawingCanvas
                        pageSlotId={slot.slotId}
                        docPath={viewerFile.path}
                        isDrawingMode={activeTool === "draw"}
                      />
                      <div
                        className="absolute top-2 right-2 text-xs px-1.5 py-0.5 rounded pointer-events-none"
                        style={{ background: "rgba(0,0,0,0.12)", color: "#888", textTransform: "capitalize" }}
                      >
                        {vp.template}
                      </div>
                    </div>
                    </div>
                  </div>
                );
              }
            })}
          </div>
        </div>

        {/* Right: tool sidebar — the sample book */}
        <div
          className={`h-full flex-col ${activeTool === "draw" || !showTools || readingMode ? "hidden" : "flex"}`}
          style={{ width: "var(--panel-w)", flexShrink: 0 }}
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

function AddPageBar({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="group flex items-center justify-center w-full" style={{ height: "28px", position: "relative" }}>
      <button
        onClick={onAdd}
        className="add-page-btn flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          background: "var(--rose)",
          color: "var(--rose-ink)",
          boxShadow: "var(--shadow-pop)",
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
