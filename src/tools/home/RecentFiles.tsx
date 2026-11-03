import React, { useState, type CSSProperties } from "react";
import { IcStar, IcArchive, IcGrid, IcList, IcFile, IcChevron, type IconProps } from "../../components/Icons";
import type { LibraryEntry, RecentFile } from "../../lib/schemas";
import { thumbUrl } from "../../render/renderClient";
import { useDocVersion } from "../../render/docVersion";
import { chipStyle, FAMILY, type Family } from "../../lib/families";
import { shortcutLabel } from "../../lib/platform";
import { formatRelativeTime, formatBytes } from "./types";
import { useFileMeasure } from "./useFileMeasure";
import type { StandaloneTool } from "./tools";

export function SectionHead({ title, meta, right }: { title: string; meta?: string; right?: React.ReactNode }) {
  return (
    <header className="section-head">
      <h2>{title}</h2>
      {meta && <span className="t-meta">{meta}</span>}
      <span className="spacer" />
      {right}
    </header>
  );
}

export function ViewToggle({ mode, setMode }: { mode: "grid" | "list"; setMode: (m: "grid" | "list") => void }) {
  return (
    <div className="seg" role="group" aria-label="View mode">
      <button type="button" className="seg-item" onClick={() => setMode("grid")} aria-label="Grid view" aria-pressed={mode === "grid"}><IcGrid size={14} /></button>
      <button type="button" className="seg-item" onClick={() => setMode("list")} aria-label="List view" aria-pressed={mode === "list"}><IcList size={14} /></button>
    </div>
  );
}

export function EmptyShelf({ title, note }: { title: string; note: string }) {
  return (
    <div className="empty">
      <IcFile size={24} style={{ color: "var(--fg3)" }} />
      <strong>{title}</strong>
      <span>{note}</span>
    </div>
  );
}

/** One tool as a row in its family group: icon, name and what it does, shortcut at the edge. */
export function ToolRow({ tool, onClick }: { tool: StandaloneTool; onClick: () => void }) {
  const { Icon } = tool;
  return (
    <button type="button" className="row tool-row" onClick={onClick}>
      <span className="tool-row-icon" aria-hidden="true"><Icon size={16} /></span>
      <span className="tool-row-text">
        <span className="tool-row-title">{tool.title}</span>
        <span className="tool-row-desc">{tool.desc}</span>
      </span>
      {tool.shortcut && <kbd className="kbd">{shortcutLabel(tool.shortcut)}</kbd>}
    </button>
  );
}

/** A family of tools with its chip and thumb-index tab. */
export function ToolFamily({ family, children }: { family: Family; children: React.ReactNode }) {
  return (
    <section className="family-col" style={chipStyle(family) as CSSProperties} aria-label={FAMILY[family].label}>
      <div className="family-col-head">
        <span className="chip">{FAMILY[family].label}</span>
        <span className="thumb-tab" aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}

export function FamilyNote({ family, note, onClick }: { family: Family; note: string; onClick: () => void }) {
  return (
    <button type="button" className="family-note" onClick={onClick} style={chipStyle(family) as CSSProperties}>
      <span className="chip">{FAMILY[family].label}</span>
      <span className="family-note-text">{note}</span>
    </button>
  );
}

function Measure({ path }: { path: string }) {
  const { data } = useFileMeasure(path);
  if (!data) return <span />;
  return <span className="t-num">{data.pages} {data.pages === 1 ? "page" : "pages"} · {formatBytes(data.bytes)}</span>;
}

function ActionButton({ active, label, Icon, onClick }: {
  active: boolean; label: string; Icon: (p: IconProps) => React.ReactElement; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sheet-action"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <Icon size={13} />
    </button>
  );
}

/** A sheet on the shelf: thumbnail on white, name, and its measure. */
export function SheetCard({ file, onOpen, starred, archived, onToggleStar, onToggleArchive }: {
  file: RecentFile; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  useDocVersion(file.path); // new thumbnail URL when Qyra rewrites the file
  const thumb = thumbFailed ? null : thumbUrl(file.path, 1, 256);
  const name = file.name.replace(/\.pdf$/i, "");

  return (
    <div
      className="sheet"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      aria-label={`Open ${file.name}`}
      title={file.path}
    >
      <div className="sheet-thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} />
        ) : (
          <span className="sheet-thumb-blank"><IcFile size={22} /></span>
        )}
        {(onToggleStar || onToggleArchive) && (
          <div className="sheet-actions" data-on={starred || archived ? "true" : undefined}>
            {onToggleStar && <ActionButton active={!!starred} label={starred ? `Unstar ${file.name}` : `Star ${file.name}`} Icon={IcStar} onClick={onToggleStar} />}
            {onToggleArchive && <ActionButton active={!!archived} label={archived ? `Unarchive ${file.name}` : `Archive ${file.name}`} Icon={IcArchive} onClick={onToggleArchive} />}
          </div>
        )}
      </div>
      <div className="sheet-name">{name}</div>
      <div className="sheet-meta">
        <Measure path={file.path} />
        <span>{formatRelativeTime(file.openedAt)}</span>
      </div>
    </div>
  );
}

function ListRow({ file, onOpen, starred, archived, onToggleStar, onToggleArchive }: {
  file: RecentFile; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
}) {
  const { data } = useFileMeasure(file.path);
  return (
    <div
      className="list-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      aria-label={`Open ${file.name}`}
      title={file.path}
    >
      <span className="list-icon"><IcFile size={16} /></span>
      <span className="list-name">{file.name}</span>
      <span className="list-num">{data ? data.pages : ""}</span>
      <span className="list-num">{data ? formatBytes(data.bytes) : ""}</span>
      <span className="list-num">{formatRelativeTime(file.openedAt)}</span>
      <span className="list-actions">
        {onToggleStar && <ActionButton active={!!starred} label={starred ? `Unstar ${file.name}` : `Star ${file.name}`} Icon={IcStar} onClick={onToggleStar} />}
        {onToggleArchive && <ActionButton active={!!archived} label={archived ? `Unarchive ${file.name}` : `Archive ${file.name}`} Icon={IcArchive} onClick={onToggleArchive} />}
      </span>
    </div>
  );
}

export function SheetList({ files, onOpen, entryMap, onToggleStar, onToggleArchive }: {
  files: RecentFile[];
  onOpen: (f: RecentFile) => void;
  entryMap?: Map<string, LibraryEntry>;
  onToggleStar?: (f: RecentFile) => void;
  onToggleArchive?: (f: RecentFile) => void;
}) {
  return (
    <div className="list" role="list">
      <div className="list-head t-label" aria-hidden="true">
        <span /><span>Name</span><span className="list-num">Pages</span><span className="list-num">Size</span><span className="list-num">Opened</span><span />
      </div>
      {files.map((f) => (
        <ListRow
          key={f.path} file={f}
          onOpen={() => onOpen(f)}
          starred={entryMap?.get(f.path)?.starred ?? false}
          archived={entryMap?.get(f.path)?.archived ?? false}
          onToggleStar={onToggleStar ? () => onToggleStar(f) : undefined}
          onToggleArchive={onToggleArchive ? () => onToggleArchive(f) : undefined}
        />
      ))}
    </div>
  );
}

export function ViewAll({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn-ghost btn-sm" onClick={onClick}>
      View all <IcChevron size={12} />
    </button>
  );
}
