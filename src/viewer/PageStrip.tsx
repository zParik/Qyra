import { Fragment, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface PageStripProps {
  pageCount: number;
  thumbnails: Record<number, string>;
  currentPage: number;
  onPageSelect: (page: number) => void;
  selectionMode?: boolean;
  selectedPages?: Set<number>;
  onPageToggle?: (page: number) => void;
  splitAfter?: number;
  onSplitAfterChange?: (page: number) => void;
  onVisibleRangeChange?: (range: [number, number]) => void;
}

const SLOT_HEIGHT = 120;
const OVERSCAN = Math.ceil(400 / SLOT_HEIGHT);

export function PageStrip({
  pageCount,
  thumbnails,
  currentPage,
  onPageSelect,
  selectionMode = false,
  selectedPages,
  onPageToggle,
  splitAfter,
  onSplitAfterChange,
  onVisibleRangeChange,
}: PageStripProps) {
  const isSplitMode = onSplitAfterChange !== undefined;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SLOT_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Notify parent of visible range so thumbnail hook can prioritize renders
  useEffect(() => {
    if (virtualItems.length === 0) return;
    const first = virtualItems[0].index + 1;
    const last = virtualItems[virtualItems.length - 1].index + 1;
    onVisibleRangeChange?.([first, last]);
  }, [virtualItems, onVisibleRangeChange]);

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

  return (
    <div style={{
      width: 168, display: "flex", flexDirection: "column", height: "100%",
      background: "var(--viewer-bg)", borderRight: "1px solid var(--viewer-border)",
    }}>
      {/* Subbar header */}
      <div style={{
        height: 32, padding: "0 14px", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid var(--viewer-border-sub)",
      }}>
        <span style={{
          fontFamily: "'Inter', system-ui, sans-serif", fontSize: 11, fontWeight: 600,
          color: "var(--viewer-text)", textTransform: "uppercase", letterSpacing: "0.6px",
        }}>Pages</span>
        <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, color: "var(--viewer-text-muted)" }}>
          {pageCount}
        </span>
      </div>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualItems.map((vItem) => {
            const page = vItem.index + 1;
            const isSelected = selectionMode && !isSplitMode && (selectedPages?.has(page) ?? false);
            const isActive = !selectionMode && !isSplitMode && page === currentPage;
            const isSplitPoint = isSplitMode && splitAfter === page;

            return (
              <Fragment key={page}>
                <button
                  onClick={() => handleClick(page)}
                  className="rounded-lg overflow-hidden border-2 transition-colors block relative"
                  title={isSplitMode ? `Split after page ${page}` : undefined}
                  style={{
                    position: "absolute",
                    top: vItem.start,
                    left: 8,
                    right: 8,
                    height: SLOT_HEIGHT - 6,
                    borderColor: isSelected
                      ? "var(--v-bad-border, #ef4444)"
                      : isActive || isSplitPoint
                      ? "var(--action)"
                      : "transparent",
                    cursor: isSplitMode ? "pointer" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected && !isActive && !isSplitPoint)
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--viewer-border)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected && !isActive && !isSplitPoint)
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
                  }}
                >
                  <div
                    className="flex items-center justify-center relative"
                    style={{ background: "var(--viewer-elevated)", height: SLOT_HEIGHT - 28 }}
                  >
                    {thumbnails[page] ? (
                      <img
                        src={thumbnails[page]}
                        alt={`Page ${page}`}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <svg
                        className="w-5 h-5"
                        style={{ color: "var(--viewer-text-muted)" }}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                    )}

                    {isSelected && (
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ background: "rgba(239, 68, 68, 0.35)" }}
                      >
                        <svg className="w-6 h-6 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div
                    className="text-center py-0.5 text-xs"
                    style={{
                      color: isSelected
                        ? "var(--v-bad-text, #ef4444)"
                        : isActive || isSplitPoint
                        ? "var(--action)"
                        : "var(--viewer-text-muted)",
                    }}
                  >
                    {page}
                  </div>
                </button>

                {isSplitMode && splitAfter === page && page < pageCount && (
                  <div
                    className="relative flex items-center gap-1.5"
                    style={{
                      position: "absolute",
                      top: vItem.start + SLOT_HEIGHT - 4,
                      left: 8,
                      right: 8,
                      height: 8,
                      color: "var(--action)",
                    }}
                  >
                    <div className="flex-1 h-px" style={{ background: "var(--action)" }} />
                    <svg
                      className="w-3 h-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="6" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <line x1="20" y1="4" x2="8.12" y2="15.88" />
                      <line x1="14.47" y1="14.48" x2="20" y2="20" />
                      <line x1="8.12" y1="8.12" x2="12" y2="12" />
                    </svg>
                    <div className="flex-1 h-px" style={{ background: "var(--action)" }} />
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
