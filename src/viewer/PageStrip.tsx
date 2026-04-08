import { Fragment, useRef, useEffect, useState, useCallback } from "react";

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

/**
 * Fixed height for each thumbnail slot (image + label + gap).
 * Using a fixed height lets us calculate which items are visible
 * without measuring every element.
 */
const SLOT_HEIGHT = 120; // px (thumbnail ~96px + label ~16px + padding ~8px)
const BUFFER_PX = 400;   // render this many pixels ahead/behind viewport

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
  // Start tiny; first layout pass computes the real viewport range.
  // This avoids kicking off a large burst of thumbnail renders on open.
  const [visibleRange, setVisibleRange] = useState<[number, number]>([1, 1]);
  // Track range in a ref so updateVisibleRange can dedup without stale closure issues
  const visibleRangeRef = useRef<[number, number]>([1, 1]);

  // Calculate which pages are visible based on scroll position
  const updateVisibleRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    const viewportHeight = el.clientHeight;

    const firstVisible = Math.max(1, Math.floor((scrollTop - BUFFER_PX) / SLOT_HEIGHT) + 1);
    const lastVisible = Math.min(pageCount, Math.ceil((scrollTop + viewportHeight + BUFFER_PX) / SLOT_HEIGHT));

    const [pf, pl] = visibleRangeRef.current;
    if (pf === firstVisible && pl === lastVisible) return;

    const next: [number, number] = [firstVisible, lastVisible];
    visibleRangeRef.current = next;
    setVisibleRange(next);
    // Must be called outside the setState updater — calling setState on another
    // component from inside a state reducer triggers a React invariant error.
    onVisibleRangeChange?.(next);
  }, [pageCount, onVisibleRangeChange]);

  useEffect(() => {
    updateVisibleRange();
  }, [pageCount, updateVisibleRange]);

  // On scroll, update visible range
  const handleScroll = useCallback(() => {
    updateVisibleRange();
  }, [updateVisibleRange]);

  // Total scrollable height
  const totalHeight = pageCount * SLOT_HEIGHT;

  // Keep hooks order stable across renders.
  if (pageCount === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="w-32.5 flex-1 min-h-0 overflow-y-auto"
      style={{
        background: "var(--viewer-bg)",
        borderRight: "1px solid var(--viewer-border)",
      }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {Array.from(
          { length: visibleRange[1] - visibleRange[0] + 1 },
          (_, i) => visibleRange[0] + i,
        ).map((page) => {
          const isSelected = selectionMode && !isSplitMode && (selectedPages?.has(page) ?? false);
          const isActive = !selectionMode && !isSplitMode && page === currentPage;
          const isSplitPoint = isSplitMode && splitAfter === page;

          function handleClick() {
            if (isSplitMode) {
              onSplitAfterChange!(page);
            } else if (selectionMode && onPageToggle) {
              onPageToggle(page);
            } else {
              onPageSelect(page);
            }
          }

          const top = (page - 1) * SLOT_HEIGHT;

          return (
            <Fragment key={page}>
              <button
                onClick={handleClick}
                className="rounded-lg overflow-hidden border-2 transition-colors block relative"
                title={isSplitMode ? `Split after page ${page}` : undefined}
                style={{
                  position: "absolute",
                  top,
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

                  {/* Remove-pages overlay */}
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

              {/* Split divider — rendered after page N when splitAfter === N */}
              {isSplitMode && splitAfter === page && page < pageCount && (
                <div
                  className="relative flex items-center gap-1.5"
                  style={{
                    position: "absolute",
                    top: top + SLOT_HEIGHT - 4,
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
                    {/* scissors icon */}
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
  );
}
