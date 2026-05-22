import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UI, MONO } from "../lib/tokens";

interface Props {
  path: string;
  pageCount: number;
  startPage?: number;
  onClose: () => void;
}

export function PresentationMode({ path, pageCount, startPage = 1, onClose }: Props) {
  const [page, setPage] = useState(startPage);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<string>("render_page", { path, page, scale: 1.5 })
      .then((b64) => {
        if (!cancelled) {
          setImgUrl(`data:image/jpeg;base64,${b64}`);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, page]);

  const next = useCallback(() => setPage((p) => Math.min(p + 1, pageCount)), [pageCount]);
  const prev = useCallback(() => setPage((p) => Math.max(p - 1, 1)), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        prev();
      } else if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Home") {
        setPage(1);
      } else if (e.key === "End") {
        setPage(pageCount);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose, pageCount]);

  function handleClick(e: React.MouseEvent) {
    const x = e.clientX / window.innerWidth;
    if (x > 0.5) next();
    else prev();
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#0a0a0a",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "default",
      }}
      onClick={handleClick}
    >
      {/* Page image */}
      {imgUrl && (
        <img
          src={imgUrl}
          alt={`Page ${page}`}
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: "100vh",
            objectFit: "contain",
            display: "block",
            opacity: loading ? 0.5 : 1,
            transition: "opacity 80ms",
          }}
        />
      )}
      {loading && !imgUrl && (
        <div style={{ color: "rgba(255,255,255,0.3)", fontFamily: MONO, fontSize: 12 }}>
          Loading…
        </div>
      )}

      {/* Page counter */}
      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          color: "rgba(255,255,255,0.35)",
          fontFamily: MONO,
          fontSize: 12,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {page} / {pageCount}
      </div>

      {/* Prev zone hint */}
      <div
        style={{
          position: "absolute",
          left: 0, top: 0, bottom: 0,
          width: "12%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: page > 1 ? 0.25 : 0,
          transition: "opacity 150ms",
          pointerEvents: "none",
          color: "#fff",
        }}
      >
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" viewBox="0 0 24 24">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </div>

      {/* Next zone hint */}
      <div
        style={{
          position: "absolute",
          right: 0, top: 0, bottom: 0,
          width: "12%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: page < pageCount ? 0.25 : 0,
          transition: "opacity 150ms",
          pointerEvents: "none",
          color: "#fff",
        }}
      >
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" viewBox="0 0 24 24">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>

      {/* Exit button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 6,
          color: "rgba(255,255,255,0.6)",
          padding: "5px 10px",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: UI,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
        title="Exit presentation (Esc)"
      >
        <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" viewBox="0 0 16 16">
          <path d="M12 4L4 12M4 4l8 8" />
        </svg>
        Exit
      </button>
    </div>
  );
}
