import React, { useEffect, useRef } from "react";
import { IcSearch, IcClose } from "../components/Icons";

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
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
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
        ? "No matches"
        : `${currentMatch} / ${matchCount}`;

  return (
    <div className="findbar" role="search" aria-label="Find in document">
      <div className="findbar-field">
        <IcSearch size={16} style={{ color: "var(--fg2)", flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in document…"
          aria-label="Find in document"
          className="findbar-input"
        />
        {hasQuery && (
          <span
            className="t-meta findbar-status"
            role="status"
            style={{ color: !ocrSearching && matchCount === 0 ? "var(--bad)" : undefined }}
          >
            {ocrSearching && (
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.25} />
                <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
              </svg>
            )}
            {statusText}
          </span>
        )}
      </div>

      <button type="button" onClick={onPrev} disabled={matchCount === 0} className="btn-icon" title="Previous match (Shift+Enter)">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 10l4-4 4 4" />
        </svg>
      </button>
      <button type="button" onClick={onNext} disabled={matchCount === 0} className="btn-icon" title="Next match (Enter)">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <button type="button" onClick={onClose} className="btn-icon" title="Close (Escape)" aria-label="Close find bar">
        <IcClose size={16} />
      </button>
    </div>
  );
}
