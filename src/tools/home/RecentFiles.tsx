import React, { useEffect, useState } from "react";
import { UI, MONO } from "../../lib/tokens";
import { IconProps, IcStar, IcArchive, IcGrid, IcList, IcFile, IcChevron } from "../../components/Icons";
import type { LibraryEntry, RecentFile } from "../../lib/schemas";
import { renderPage } from "../../hooks/usePageThumbnails";
import { formatRelativeTime, fileSwatch } from "./types";

export function SectionHeader({ title, subtitle, right }: {
  title: string; subtitle?: string; right?: React.ReactNode;
}) {
  return (
    <header className="section-header">
      <h2 style={{ fontFamily: UI }}>{title}</h2>
      {subtitle && <span className="text-[11px]" style={{ fontFamily: MONO, color: "var(--fg2)" }}>{subtitle}</span>}
      <div className="section-divider" />
      {right}
    </header>
  );
}

export function ViewToggle({ mode, setMode }: { mode: "grid" | "list"; setMode: (m: "grid" | "list") => void }) {
  return (
    <div className="flex gap-0.5" role="group" aria-label="View mode">
      <button onClick={() => setMode("grid")} aria-label="Grid view" aria-pressed={mode === "grid"} className="view-toggle-btn"><IcGrid size={13} /></button>
      <button onClick={() => setMode("list")} aria-label="List view" aria-pressed={mode === "list"} className="view-toggle-btn"><IcList size={13} /></button>
    </div>
  );
}

export function EmptyRecents() {
  return (
    <div className="empty-state">
      <IcFile size={28} style={{ color: "var(--fg3)" }} />
      <div className="text-[13px] text-center" style={{ fontFamily: UI, color: "var(--fg2)" }}>
        No recent files — open a PDF to get started.
      </div>
    </div>
  );
}

export function QuickToolCard({ Icon, title, desc, meta, shortcut, onClick, isMobile }: {
  Icon: (p: IconProps) => React.ReactElement;
  title: string; desc: string; meta: string; shortcut: string;
  onClick: () => void;
  isMobile: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="quick-tool-card"
      style={{
        padding: isMobile ? 14 : 16,
        display: "grid",
        gridTemplateColumns: isMobile ? "36px 1fr" : "40px 1fr auto",
        gap: isMobile ? 12 : 14, alignItems: "flex-start",
      }}
    >
      <div className="tool-icon" style={{ width: isMobile ? 36 : 40, height: isMobile ? 36 : 40 }}>
        <Icon size={isMobile ? 18 : 20} />
      </div>
      <div className="flex flex-col gap-1 min-w-0">
        <div className="font-semibold" style={{ fontFamily: UI, fontSize: isMobile ? 13 : 13.5, color: "var(--fg0)" }}>{title}</div>
        <div className="leading-snug" style={{ fontFamily: UI, fontSize: 12, color: "var(--fg1)" }}>{desc}</div>
        <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>{meta}</div>
      </div>
      {!isMobile && (
        <div className="flex flex-col items-end gap-2">
          <span className="text-[10px] px-1 py-0.5 rounded"
            style={{ fontFamily: MONO, color: "var(--fg2)", border: "1px solid var(--line)" }}>{shortcut}</span>
          <span className="tool-chevron"><IcChevron size={13} /></span>
        </div>
      )}
    </button>
  );
}

export function RecentCard({ file, onOpen, starred, archived, onToggleStar, onToggleArchive, isMobile }: {
  file: RecentFile; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
  isMobile: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const swatch = fileSwatch(file.name);
  const ext = file.name.split(".").pop()?.toUpperCase() ?? "PDF";

  useEffect(() => {
    let cancelled = false;
    renderPage(file.path, 1, 0.3).then((dataUrl) => {
      if (!cancelled) setThumb(dataUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [file.path]);

  const showActions = isMobile || hover;

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer", display: "flex", flexDirection: "column", gap: 8,
        padding: 8, borderRadius: 6,
        background: hover ? "var(--bg1)" : "transparent",
        border: `1px solid ${hover ? "var(--line)" : "transparent"}`,
        transition: "all 100ms ease",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "0.77 / 1", width: "100%", borderRadius: 3, overflow: "hidden", border: "1px solid var(--line)", background: "var(--bg2)" }}>
        {thumb ? (
          <img src={thumb} className="absolute inset-0 w-full h-full object-cover" alt="" />
        ) : (
          <>
            <div className="absolute inset-0" style={{ background: "repeating-linear-gradient(180deg, transparent 0 8px, var(--line2) 8px 9px)" }} />
            <div className="absolute top-0 left-0 right-0" style={{ height: "34%", background: swatch }} />
            <div className="absolute top-1.5 left-1.5" style={{ fontFamily: MONO, fontSize: 8, color: "rgba(255,255,255,0.85)", letterSpacing: 1, textTransform: "uppercase" }}>{ext}</div>
          </>
        )}
        <div className="absolute truncate" style={{ bottom: 7, left: 7, right: 7, fontFamily: UI, fontSize: 10.5, fontWeight: 600, color: "var(--fg0)", background: "var(--bg2)", padding: "3px 5px", borderRadius: 2, border: "1px solid var(--line)" }}>
          {file.name.replace(/\.pdf$/i, "")}
        </div>
        {showActions && (
          <div className="absolute top-1.5 right-1.5 flex flex-col gap-0.5">
            {onToggleStar && (
              <button onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
                aria-label={starred ? `Unstar ${file.name}` : `Star ${file.name}`} aria-pressed={starred}
                className="flex items-center justify-center rounded cursor-pointer"
                style={{ width: isMobile ? 28 : 22, height: isMobile ? 28 : 22, border: "none", background: starred ? "var(--accent)" : "var(--bg2)", color: starred ? "#fff" : "var(--fg1)", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }}>
                <IcStar size={isMobile ? 13 : 11} />
              </button>
            )}
            {onToggleArchive && (
              <button onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
                aria-label={archived ? `Unarchive ${file.name}` : `Archive ${file.name}`} aria-pressed={archived}
                className="flex items-center justify-center rounded cursor-pointer"
                style={{ width: isMobile ? 28 : 22, height: isMobile ? 28 : 22, border: "none", background: archived ? "var(--bg3)" : "var(--bg2)", color: "var(--fg1)", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }}>
                <IcArchive size={isMobile ? 13 : 11} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-0.5">
        <div className="truncate font-medium" style={{ fontFamily: UI, fontSize: 12, color: "var(--fg0)" }}>{file.name.replace(/\.pdf$/i, "")}</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>{formatRelativeTime(file.openedAt)}</div>
      </div>
    </div>
  );
}

function ListRow({ file, swatch, index, onOpen, starred, archived, onToggleStar, onToggleArchive, isMobile }: {
  file: RecentFile; swatch: string; index: number; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
  isMobile: boolean;
}) {
  const [hover, setHover] = useState(false);
  const showActions = isMobile || hover;

  const iconBtn = (active: boolean, label: string, Icon: (p: IconProps) => React.ReactElement, onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={label} aria-pressed={active}
      className="flex items-center justify-center rounded cursor-pointer"
      style={{
        width: isMobile ? 32 : 22, height: isMobile ? 32 : 22, border: "none",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--fg2)",
        opacity: showActions || active ? 1 : 0,
        transition: "opacity 80ms",
      }}
    >
      <Icon size={isMobile ? 14 : 11} />
    </button>
  );

  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`Open ${file.name}`}
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "20px 1fr auto" : "24px 1fr 120px 52px",
        padding: isMobile ? "10px 14px" : "8px 14px",
        gap: 12, alignItems: "center",
        background: hover ? "var(--bg2)" : "transparent",
        border: "none",
        borderTop: index === 0 ? "none" : "1px solid var(--line2)",
        width: "100%", textAlign: "left", cursor: "pointer",
        transition: "background 80ms",
        minHeight: isMobile ? 48 : undefined,
      }}
    >
      <span style={{ width: isMobile ? 16 : 18, height: isMobile ? 20 : 22, background: swatch, borderRadius: 2, display: "inline-block" }} />
      <span className="truncate" style={{ fontFamily: UI, fontSize: isMobile ? 13 : 12.5, color: "var(--fg0)" }}>{file.name}</span>
      {!isMobile && (
        <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg1)" }}>{formatRelativeTime(file.openedAt)}</span>
      )}
      <span className="flex gap-1 justify-end">
        {onToggleStar && iconBtn(starred ?? false, starred ? `Unstar ${file.name}` : `Star ${file.name}`, IcStar, onToggleStar)}
        {onToggleArchive && iconBtn(archived ?? false, archived ? `Unarchive ${file.name}` : `Archive ${file.name}`, IcArchive, onToggleArchive)}
      </span>
    </button>
  );
}

export function RecentList({ files, onOpen, entryMap, onToggleStar, onToggleArchive, isMobile }: {
  files: RecentFile[];
  onOpen: (f: RecentFile) => void;
  entryMap?: Map<string, LibraryEntry>;
  onToggleStar?: (f: RecentFile) => void;
  onToggleArchive?: (f: RecentFile) => void;
  isMobile: boolean;
}) {
  return (
    <div className="recent-list">
      {!isMobile && (
        <div className="recent-list-header" style={{ fontFamily: MONO }}>
          <span /><span>Name</span><span>Modified</span><span />
        </div>
      )}
      {files.map((f, i) => (
        <ListRow
          key={f.path} file={f} swatch={fileSwatch(f.name)} index={i}
          onOpen={() => onOpen(f)}
          starred={entryMap?.get(f.path)?.starred ?? false}
          archived={entryMap?.get(f.path)?.archived ?? false}
          onToggleStar={onToggleStar ? () => onToggleStar(f) : undefined}
          onToggleArchive={onToggleArchive ? () => onToggleArchive(f) : undefined}
          isMobile={isMobile}
        />
      ))}
    </div>
  );
}
