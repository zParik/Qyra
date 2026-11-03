import { Fragment, memo, useRef, useEffect, useCallback, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { thumbUrl } from "../render/renderClient";
import { IcFile } from "../components/Icons";

interface PageStripProps {
  /** PDF whose pages are shown; thumbnails load from the qyra:// scheme. */
  path: string;
  /** Document version (mtime) so edited files never show stale thumbnails. */
  version?: string;
  pageCount: number;
  currentPage: number;
  onPageSelect: (page: number) => void;
  selectionMode?: boolean;
  selectedPages?: Set<number>;
  onPageToggle?: (page: number) => void;
  splitAfter?: number;
  onSplitAfterChange?: (page: number) => void;
  onReorder?: (fromPage: number, dropBeforePage: number) => void;
}

const SLOT_HEIGHT = 128;
const OVERSCAN = Math.ceil(400 / SLOT_HEIGHT);

/**
 * The page strip: every page as a small white sheet in a column, the current
 * one ringed in rose. Also hosts remove-mode selection, the split marker and
 * drag reorder.
 */
function PageStripImpl({
  path,
  version,
  pageCount,
  currentPage,
  onPageSelect,
  selectionMode = false,
  selectedPages,
  onPageToggle,
  splitAfter,
  onSplitAfterChange,
  onReorder,
}: PageStripProps) {
  const isSplitMode = onSplitAfterChange !== undefined;
  const isDragEnabled = !!onReorder && !selectionMode && !isSplitMode;
  const dragPageRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SLOT_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Auto-scroll active page into view
  useEffect(() => {
    if (currentPage < 1 || currentPage > pageCount) return;
    virtualizer.scrollToIndex(currentPage - 1, { behavior: "smooth" });
  }, [currentPage]);

  const handleClick = useCallback((page: number) => {
    if (isSplitMode) {
      onSplitAfterChange!(page);
    } else if (selectionMode && onPageToggle) {
      onPageToggle(page);
    } else {
      onPageSelect(page);
    }
  }, [isSplitMode, selectionMode, onPageToggle, onPageSelect, onSplitAfterChange]);

  if (pageCount === 0) return null;

  const hint = isSplitMode ? "Click a page to split after it" : selectionMode ? "Click pages to select them" : null;

  return (
    <div className="strip">
      <div className="strip-head">
        <span className="t-label">Pages</span>
        <span className="t-meta">{pageCount}</span>
      </div>
      {hint && <div className="strip-hint">{hint}</div>}

      <div ref={scrollRef} className="strip-scroll">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualItems.map((vItem) => {
            const page = vItem.index + 1;
            const isSelected = selectionMode && !isSplitMode && (selectedPages?.has(page) ?? false);
            const isActive = !selectionMode && !isSplitMode && page === currentPage;
            const isSplitPoint = isSplitMode && splitAfter === page;
            const isDropTarget = dropTarget === page;
            const state = isSelected ? "selected" : isActive || isSplitPoint ? "active" : undefined;

            return (
              <Fragment key={page}>
                {isDropTarget && isDragEnabled && (
                  <div className="strip-drop" style={{ top: vItem.start - 3 }} aria-hidden="true" />
                )}
                <button
                  type="button"
                  onClick={() => handleClick(page)}
                  className="strip-sheet"
                  data-state={state}
                  aria-current={isActive ? "page" : undefined}
                  aria-pressed={selectionMode ? isSelected : undefined}
                  aria-label={isSplitMode ? `Split after page ${page}` : `Page ${page}`}
                  title={isSplitMode ? `Split after page ${page}` : undefined}
                  draggable={isDragEnabled}
                  onDragStart={isDragEnabled ? (e) => {
                    dragPageRef.current = page;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(page));
                  } : undefined}
                  onDragOver={isDragEnabled ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragPageRef.current !== null && dragPageRef.current !== page) {
                      setDropTarget(page);
                    }
                  } : undefined}
                  onDragLeave={isDragEnabled ? () => {
                    setDropTarget(null);
                  } : undefined}
                  onDrop={isDragEnabled ? (e) => {
                    e.preventDefault();
                    const from = dragPageRef.current;
                    if (from !== null && from !== page) {
                      onReorder!(from, page);
                    }
                    dragPageRef.current = null;
                    setDropTarget(null);
                  } : undefined}
                  onDragEnd={isDragEnabled ? () => {
                    dragPageRef.current = null;
                    setDropTarget(null);
                  } : undefined}
                  style={{
                    top: vItem.start,
                    height: SLOT_HEIGHT - 8,
                    cursor: isDragEnabled ? "grab" : "pointer",
                    opacity: isDragEnabled && dragPageRef.current === page ? 0.4 : 1,
                  }}
                >
                  <span className="strip-thumb">
                    {/* Placeholder underneath; the thumbnail covers it once loaded and
                        hides itself if it fails, revealing the icon. */}
                    <IcFile size={20} style={{ color: "var(--paper-5)" }} />
                    <img
                      src={thumbUrl(path, page, 256, version)}
                      alt=""
                      draggable={false}
                      onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                    />
                    {isSelected && (
                      <span className="strip-selected" aria-hidden="true">
                        <svg width={20} height={20} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </span>
                    )}
                  </span>
                  <span className="strip-num">{page}</span>
                </button>

                {isSplitMode && splitAfter === page && page < pageCount && (
                  <div className="strip-split" style={{ top: vItem.start + SLOT_HEIGHT - 6 }} aria-hidden="true">
                    <span />
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
                      <line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" />
                    </svg>
                    <span />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Memoized: the viewer re-renders while scrolling; this only needs to when its props change.
export const PageStrip = memo(PageStripImpl);
