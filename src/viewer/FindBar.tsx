import React, { useEffect, useRef } from "react";

interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  /** 1-based index of current match, 0 when there are no matches */
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** True while OCR scanning is in progress */
  ocrSearching?: boolean;
  /** Progress through OCR scanning: { page, total } */
  ocrProgress?: { page: number; total: number };
}

export function FindBar({
  query,
  onQueryChange,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
  onClose,
  ocrSearching,
  ocrProgress,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.shiftKey ? onPrev() : onNext();
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  const hasQuery = query.trim() !== "";

  const statusText = !hasQuery
    ? ""
    : ocrSearching
      ? ocrProgress
        ? `Scanning ${ocrProgress.page} / ${ocrProgress.total}…`
        : "Scanning…"
      : matchCount === 0
        ? "No results"
        : `${currentMatch} / ${matchCount}`;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 shrink-0"
      style={{
        background: "var(--viewer-surface)",
        borderBottom: "1px solid var(--viewer-border)",
      }}
    >
      {/* Search icon */}
      <svg
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: "var(--viewer-text-muted)" }}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
        />
      </svg>

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in document…"
        className="flex-1 text-sm outline-none min-w-0 px-2 py-0.5 rounded"
        style={{
          background: "var(--viewer-elevated)",
          border: "1px solid var(--viewer-border)",
          color: "var(--viewer-text)",
          caretColor: "var(--viewer-text)",
        }}
      />

      {/* Status */}
      {hasQuery && (
        ocrSearching ? (
          <span className="flex items-center gap-1.5 text-xs shrink-0 tabular-nums"
            style={{ color: "var(--viewer-text-muted)" }}>
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="12" cy="12" r="10" strokeWidth={2} strokeOpacity={0.25} />
              <path d="M12 2a10 10 0 0 1 10 10" strokeWidth={2} strokeLinecap="round" />
            </svg>
            {statusText}
          </span>
        ) : (
          <span
            className="text-xs shrink-0 tabular-nums"
            style={{ color: matchCount === 0 ? "var(--v-bad-text)" : "var(--viewer-text-muted)" }}
          >
            {statusText}
          </span>
        )
      )}

      <button
        onClick={onPrev}
        disabled={matchCount === 0}
        className="v-icon-btn p-1 rounded disabled:opacity-30"
        title="Previous match (Shift+Enter)"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>

      <button
        onClick={onNext}
        disabled={matchCount === 0}
        className="v-icon-btn p-1 rounded disabled:opacity-30"
        title="Next match (Enter)"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <button
        onClick={onClose}
        className="v-icon-btn p-1 rounded"
        title="Close find bar (Escape)"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
