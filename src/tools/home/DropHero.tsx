import React from "react";
import { UI, MONO } from "../../lib/tokens";
import { IcUpload, IcFolder } from "../../components/Icons";

function CornerMarks() {
  const mark = (pos: React.CSSProperties) => (
    <div style={{ position: "absolute", width: 10, height: 10, borderColor: "var(--fg3)", pointerEvents: "none", ...pos }} />
  );
  return (
    <>
      {mark({ top: 8, left: 8, borderTop: "1px solid", borderLeft: "1px solid" })}
      {mark({ top: 8, right: 8, borderTop: "1px solid", borderRight: "1px solid" })}
      {mark({ bottom: 8, left: 8, borderBottom: "1px solid", borderLeft: "1px solid" })}
      {mark({ bottom: 8, right: 8, borderBottom: "1px solid", borderRight: "1px solid" })}
    </>
  );
}

export function DropHero({ drag, onDragOver, onDragLeave, onDrop, onClick, loading, isMobile }: {
  drag: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onClick: () => void;
  loading: string | null;
  isMobile: boolean;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: "relative", borderRadius: 8, overflow: "hidden",
        border: `1px ${drag ? "solid" : "dashed"} ${drag ? "var(--accent)" : "var(--line)"}`,
        background: drag ? "var(--accent-soft)" : "var(--bg1)",
        transition: "all 120ms ease",
        padding: isMobile ? "24px 20px" : "36px 32px",
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) auto",
        gap: 24, alignItems: "center",
        minHeight: isMobile ? 148 : 196,
      }}
    >
      <CornerMarks />
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        opacity: drag ? 0.18 : 0.04,
        background: "repeating-linear-gradient(45deg, transparent 0 11px, var(--fg1) 11px 12px)",
      }} />

      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: isMobile ? 10 : 14, minWidth: 0 }}>
        {!isMobile && (
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: drag ? "var(--accent)" : "var(--fg2)", letterSpacing: 1, textTransform: "uppercase" }}>
            {drag ? "Release to import" : "Drop zone / idle"}
          </div>
        )}
        <h1 style={{ margin: 0, fontFamily: UI, fontSize: isMobile ? 20 : 26, fontWeight: 600, color: "var(--fg0)", letterSpacing: -0.5, lineHeight: 1.2 }}>
          {isMobile ? (
            <>Open a PDF <span style={{ color: "var(--fg2)" }}>from your files.</span></>
          ) : (
            <>Drop a PDF here <span style={{ color: "var(--fg2)" }}>or pick from your files.</span></>
          )}
        </h1>
        {!isMobile && (
          <p style={{ margin: 0, fontFamily: UI, fontSize: 13.5, color: "var(--fg1)", lineHeight: 1.55, maxWidth: "min(42rem, 100%)" }}>
            Qyra opens documents instantly — thumbnails, text search, annotations, and form tools are
            all one click away. Files never leave your device.
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2.5 mt-1">
            <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite", color: "var(--accent)" }}>
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
              <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            <span className="truncate" style={{ fontFamily: UI, fontSize: 13, color: "var(--fg1)", maxWidth: 340 }}>
              Opening {loading}...
            </span>
          </div>
        ) : (
          <div className="flex gap-2 mt-1 flex-wrap">
            <button onClick={onClick} className="btn-primary">
              <IcUpload size={13} />
              Open document
              {!isMobile && (
                <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7, marginLeft: 4, padding: "1px 4px", border: "1px solid currentColor", borderRadius: 3 }}>Cmd+O</span>
              )}
            </button>
            {!isMobile && (
              <button className="btn-secondary" onClick={onClick}>
                <IcFolder size={13} />
                Browse
              </button>
            )}
          </div>
        )}

        {!isMobile && (
          <div className="flex gap-4" style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>
            <span><span style={{ color: "var(--fg3)" }}>FORMAT</span> .pdf .pdf/a</span>
            <span><span style={{ color: "var(--fg3)" }}>OCR</span> disabled</span>
          </div>
        )}
      </div>

      {!isMobile && (
        <div className="relative flex items-center justify-center" style={{ width: 200, height: 180 }}>
          {[2, 1, 0].map((i) => (
            <div key={i} style={{
              position: "absolute", width: 120, height: 155,
              background: "var(--bg2)", border: "1px solid var(--line)", borderRadius: 3,
              transform: `translate(${(i - 1) * 13}px, ${(i - 1) * -7}px) rotate(${(i - 1) * 4}deg)${drag ? " translateY(-5px)" : ""}`,
              transition: "transform 200ms ease",
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)", overflow: "hidden",
            }}>
              <div style={{ height: "100%", background: "repeating-linear-gradient(180deg, transparent 0 9px, var(--line2) 9px 10px)" }} />
              <div style={{ position: "absolute", top: 10, left: 10, right: 10, height: 20, background: "var(--bg3)", borderRadius: 2 }} />
              <div style={{ position: "absolute", bottom: 8, left: 10, fontFamily: MONO, fontSize: 7.5, color: "var(--fg3)" }}>{`pg-0${i + 1}`}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
