import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { useAppStore } from "../store/useAppStore";
import { getContentUriDisplayName } from "../lib/tauri";
import type { DiskSpace, LibraryEntry, RecentFile } from "../lib/schemas";
import { RecentFileSchema } from "../lib/schemas";
import { useDiskSpace, useStarred, useArchived, useSetStarred, useSetArchived } from "../lib/queries";
import { renderPage } from "../hooks/usePageThumbnails";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

// ── Typography constants ──────────────────────────────────────────────────
const UI   = "'Inter', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// ── Recent-file types + storage ───────────────────────────────────────────
const RECENT_KEY = "qyra-recent";
const MAX_RECENT = 12;

function loadRecent(): RecentFile[] {
  try { return RecentFileSchema.array().parse(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")); }
  catch { return []; }
}
function saveRecent(files: RecentFile[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(files.slice(0, MAX_RECENT)));
}
function addToRecent(path: string, name: string) {
  const files = loadRecent().filter((f) => f.path !== path);
  files.unshift({ path, name, openedAt: Date.now() });
  saveRecent(files);
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

// ── Color swatch from filename ────────────────────────────────────────────
const SWATCHES = ["#c87a52","#5e7a8a","#7a5e8a","#5e8a7a","#8a7a5e","#5e7a5e","#8a5e5e","#5e5e8a","#a08a64","#3d3d50"];
function fileSwatch(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return SWATCHES[Math.abs(h) % SWATCHES.length];
}

async function resolveAndroidUri(rawPath: string): Promise<string> {
  if (!rawPath.startsWith("content://")) return rawPath;
  const bytes = await readFile(rawPath);
  const cacheDir = await appCacheDir();
  const tmpPath = await join(cacheDir, `na_${Date.now()}.pdf`);
  await writeFile(tmpPath, bytes);
  return tmpPath;
}

async function getDisplayName(rawPath: string): Promise<string> {
  if (rawPath.startsWith("content://")) {
    try { return await getContentUriDisplayName(rawPath); }
    catch {
      const decoded = decodeURIComponent(rawPath);
      const match = decoded.match(/([^/\\:]+\.pdf)(?:[?#]|$)/i);
      return match ? match[1] : "document.pdf";
    }
  }
  return rawPath.split(/[\\/]/).pop() ?? rawPath;
}

// ─────────────────────────────────────────────────────────────────────────
// Inline SVG icons (1.5px stroke, 16×16 viewBox)
// ─────────────────────────────────────────────────────────────────────────
type IconProps = { size?: number; style?: React.CSSProperties };

function Ic({ children, size = 16, style }: { children: React.ReactNode; size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}>
      {children}
    </svg>
  );
}

const IcHome    = (p: IconProps) => <Ic {...p}><path d="M2.5 7L8 2.5 13.5 7v6.5h-3.5V10h-3v3.5H2.5z"/></Ic>;
const IcRecent  = (p: IconProps) => <Ic {...p}><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></Ic>;
const IcStar    = (p: IconProps) => <Ic {...p}><path d="M8 2l1.7 3.7 4 .5-3 2.8.8 4L8 11l-3.5 2 .8-4-3-2.8 4-.5z"/></Ic>;
const IcFolder  = (p: IconProps) => <Ic {...p}><path d="M2 4.5h4l1.5 1.5h6.5v7H2z"/></Ic>;
const IcArchive = (p: IconProps) => <Ic {...p}><rect x="2.5" y="3" width="11" height="3"/><path d="M3 6v7.5h10V6M6.5 9h3"/></Ic>;
const IcMerge   = (p: IconProps) => <Ic {...p}><path d="M3 3v3.5c0 1 .5 1.5 1.5 1.5h7c1 0 1.5-.5 1.5-1.5V3M8 8v5M5.5 10.5L8 13l2.5-2.5"/></Ic>;
const IcImage   = (p: IconProps) => <Ic {...p}><rect x="2.5" y="3" width="11" height="10" rx="0.5"/><circle cx="6" cy="6.5" r="1"/><path d="M3 11l3-3 3 3 2-2 2 2"/></Ic>;
const IcUpload  = (p: IconProps) => <Ic {...p}><path d="M8 11V3M5 6l3-3 3 3M3 13h10"/></Ic>;
const IcChevron = (p: IconProps) => <Ic {...p}><path d="M6 4l4 4-4 4"/></Ic>;
const IcGrid    = (p: IconProps) => <Ic {...p}><rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/></Ic>;
const IcList    = (p: IconProps) => <Ic {...p}><path d="M3 4h10M3 8h10M3 12h10"/></Ic>;
const IcFile    = (p: IconProps) => <Ic {...p}><path d="M3.5 2h6l3 3v9h-9z"/><path d="M9.5 2v3h3"/></Ic>;

// ─────────────────────────────────────────────────────────────────────────
// Left Rail
// ─────────────────────────────────────────────────────────────────────────
type Section = "home" | "recent" | "starred" | "local" | "archive";

interface LeftRailProps {
  active: Section;
  onPick: (id: string) => void;
  recentCount: number;
  storageUsage: DiskSpace | null;
}

function LeftRail({ active, onPick, recentCount, storageUsage }: LeftRailProps) {
  const navItems = [
    { id: "home",    label: "Home",        Icon: IcHome },
    { id: "recent",  label: "Recents",     Icon: IcRecent, badge: recentCount > 0 ? String(recentCount) : undefined },
    { id: "starred", label: "Starred",     Icon: IcStar },
    { id: "local",   label: "Local files", Icon: IcFolder },
    { id: "archive", label: "Archive",     Icon: IcArchive },
  ];
  const toolItems = [
    { id: "merge",  label: "Merge",        Icon: IcMerge },
    { id: "i2pdf",  label: "Images → PDF", Icon: IcImage },
  ];

  return (
    <aside style={{
      width: 220, flexShrink: 0,
      background: "var(--bg1)",
      borderRight: "1px solid var(--line)",
      display: "flex", flexDirection: "column",
      height: "100%",
    }}>
      {/* Library */}
      <div style={{ padding: "12px 12px 4px" }}>
        <div style={{
          fontFamily: UI, fontSize: 10, fontWeight: 600, color: "var(--fg2)",
          textTransform: "uppercase", letterSpacing: 0.8,
          padding: "4px 8px 6px",
        }}>Library</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {navItems.map(({ id, label, Icon, badge }) => (
            <RailItem key={id} id={id} label={label} Icon={Icon} badge={badge}
              active={active === id} onClick={() => onPick(id)} />
          ))}
        </div>
      </div>

      <div style={{ height: 1, background: "var(--line2)", margin: "4px 12px" }} />

      {/* Tools */}
      <div style={{ padding: "4px 12px 4px" }}>
        <div style={{
          fontFamily: UI, fontSize: 10, fontWeight: 600, color: "var(--fg2)",
          textTransform: "uppercase", letterSpacing: 0.8,
          padding: "4px 8px 6px",
        }}>Tools</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {toolItems.map(({ id, label, Icon }) => (
            <RailItem key={id} id={id} label={label} Icon={Icon}
              active={false} onClick={() => onPick(id)} />
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Storage meter */}
      <div style={{
        margin: 12, padding: 12,
        border: "1px solid var(--line)", borderRadius: 6,
        background: "var(--bg2)", fontFamily: UI,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--accent)", display: "inline-block",
          }} />
          <span style={{
            fontSize: 10.5, fontWeight: 600, color: "var(--fg0)",
            textTransform: "uppercase", letterSpacing: 0.5,
          }}>Storage</span>
        </div>
        <div style={{ height: 4, background: "var(--bg3)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
          <div style={{
            width: storageUsage
              ? `${Math.min(100, (storageUsage.used / storageUsage.total) * 100).toFixed(1)}%`
              : "0%",
            height: "100%", background: "var(--accent)", borderRadius: 2,
            transition: "width 400ms ease",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontFamily: MONO, fontSize: 10.5, color: "var(--fg1)",
        }}>
          {storageUsage ? (
            <>
              <span>{formatBytes(storageUsage.used)} used</span>
              <span style={{ color: "var(--fg2)" }}>{formatBytes(storageUsage.total)}</span>
            </>
          ) : (
            <>
              <span>Local only</span>
              <span style={{ color: "var(--fg2)" }}>offline</span>
            </>
          )}
        </div>
      </div>

      {/* User */}
      <div style={{
        padding: "10px 14px",
        borderTop: "1px solid var(--line2)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%",
          background: "var(--accent)",
          fontFamily: UI, fontWeight: 700, fontSize: 10, color: "var(--accent-text)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>Q</div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontFamily: UI, fontSize: 11.5, color: "var(--fg0)", fontWeight: 500, lineHeight: 1.2 }}>
            Qyra
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg2)", lineHeight: 1.2 }}>
            free · offline · open source
          </span>
        </div>
      </div>
    </aside>
  );
}

function RailItem({ label, Icon, badge, active, onClick }: {
  id?: string; label: string; Icon: (p: IconProps) => React.ReactElement;
  badge?: string; active: boolean; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: active ? "var(--bg3)" : hover ? "var(--bg2)" : "transparent",
        border: "none", borderRadius: 4,
        padding: "0 8px", height: 28,
        display: "flex", alignItems: "center", gap: 10,
        cursor: "pointer",
        color: active ? "var(--fg0)" : "var(--fg1)",
        fontFamily: UI, fontSize: 12.5, fontWeight: 500,
        position: "relative", textAlign: "left", width: "100%",
        transition: "background 80ms",
      }}
    >
      {active && (
        <span style={{
          position: "absolute", left: -12, top: 6, bottom: 6, width: 2,
          background: "var(--accent)", borderRadius: 1,
        }} />
      )}
      <span style={{ color: active ? "var(--accent)" : "var(--fg1)" }}>
        <Icon />
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge && (
        <span style={{
          fontFamily: MONO, fontSize: 10, color: "var(--fg2)",
          background: "var(--bg2)", padding: "1px 5px", borderRadius: 3,
          border: "1px solid var(--line2)",
        }}>{badge}</span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero drop zone
// ─────────────────────────────────────────────────────────────────────────
function DropHero({ drag, onDragOver, onDragLeave, onDrop, onClick, loading }: {
  drag: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onClick: () => void;
  loading: string | null;
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
        padding: "36px 32px",
        display: "grid", gridTemplateColumns: "1fr auto",
        gap: 24, alignItems: "center", minHeight: 196,
      }}
    >
      {/* Registration corner marks */}
      <CornerMarks />
      {/* Diagonal stripe overlay */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        opacity: drag ? 0.18 : 0.04,
        background: "repeating-linear-gradient(45deg, transparent 0 11px, var(--fg1) 11px 12px)",
      }} />

      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 14, maxWidth: 520 }}>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: drag ? "var(--accent)" : "var(--fg2)", letterSpacing: 1, textTransform: "uppercase" }}>
          {drag ? "◆ Release to import" : "◇ Drop zone · idle"}
        </div>
        <h1 style={{
          margin: 0, fontFamily: UI, fontSize: 26,
          fontWeight: 600, color: "var(--fg0)", letterSpacing: -0.5, lineHeight: 1.2,
        }}>
          Drop a PDF here{" "}
          <span style={{ color: "var(--fg2)" }}>or pick from your files.</span>
        </h1>
        <p style={{ margin: 0, fontFamily: UI, fontSize: 13.5, color: "var(--fg1)", lineHeight: 1.55, maxWidth: 440 }}>
          Qyra opens documents instantly — thumbnails, text search, annotations, and form tools are
          all one click away. Files never leave your device.
        </p>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite", color: "var(--accent)" }}>
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.2} />
              <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            <span style={{ fontFamily: UI, fontSize: 13, color: "var(--fg1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>
              Opening {loading}…
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={onClick} className="btn-primary">
              <IcUpload size={13} />
              Open document
              <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7, marginLeft: 4, padding: "1px 4px", border: "1px solid currentColor", borderRadius: 3 }}>⌘O</span>
            </button>
            <button className="btn-secondary" onClick={onClick}>
              <IcFolder size={13} />
              Browse
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>
          <span><span style={{ color: "var(--fg3)" }}>FORMAT</span> .pdf .pdf/a</span>
          <span><span style={{ color: "var(--fg3)" }}>MAX</span> 250 MB</span>
          <span><span style={{ color: "var(--fg3)" }}>OCR</span> auto</span>
        </div>
      </div>

      {/* Floating page stack graphic */}
      <div style={{ position: "relative", width: 200, height: 180, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {[2, 1, 0].map((i) => (
          <div key={i} style={{
            position: "absolute", width: 120, height: 155,
            background: "var(--bg2)", border: "1px solid var(--line)",
            borderRadius: 3,
            transform: `translate(${(i - 1) * 13}px, ${(i - 1) * -7}px) rotate(${(i - 1) * 4}deg)${drag ? " translateY(-5px)" : ""}`,
            transition: "transform 200ms ease",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              background: "repeating-linear-gradient(180deg, transparent 0 9px, var(--line2) 9px 10px)",
            }} />
            <div style={{ position: "absolute", top: 10, left: 10, right: 10, height: 20, background: "var(--bg3)", borderRadius: 2 }} />
            <div style={{
              position: "absolute", bottom: 8, left: 10,
              fontFamily: MONO, fontSize: 7.5, color: "var(--fg3)",
            }}>{`pg-0${i + 1}`}</div>
          </div>
        ))}
      </div>


    </div>
  );
}

function CornerMarks() {
  const mark = (pos: React.CSSProperties) => (
    <div style={{
      position: "absolute", width: 10, height: 10,
      borderColor: "var(--fg3)", pointerEvents: "none", ...pos,
    }} />
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

// ─────────────────────────────────────────────────────────────────────────
// Quick-action tool cards
// ─────────────────────────────────────────────────────────────────────────
function QuickToolCard({ Icon, title, desc, meta, shortcut, onClick }: {
  Icon: (p: IconProps) => React.ReactElement;
  title: string; desc: string; meta: string; shortcut: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: "left", cursor: "pointer", padding: 16,
        background: hover ? "var(--bg2)" : "var(--bg1)",
        border: `1px solid ${hover ? "var(--accent-line)" : "var(--line)"}`,
        borderRadius: 6,
        display: "grid", gridTemplateColumns: "40px 1fr auto",
        gap: 14, alignItems: "flex-start",
        transition: "all 120ms ease",
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 4,
        background: hover ? "var(--accent-soft)" : "var(--bg3)",
        color: hover ? "var(--accent)" : "var(--fg1)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={20} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ fontFamily: UI, fontSize: 13.5, fontWeight: 600, color: "var(--fg0)" }}>{title}</div>
        <div style={{ fontFamily: UI, fontSize: 12, color: "var(--fg1)", lineHeight: 1.45 }}>{desc}</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", marginTop: 4 }}>{meta}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        <span style={{
          fontFamily: MONO, fontSize: 10, color: "var(--fg2)",
          border: "1px solid var(--line)", borderRadius: 3, padding: "2px 5px",
        }}>{shortcut}</span>
        <span style={{ color: hover ? "var(--accent)" : "var(--fg2)" }}>
          <IcChevron size={13} />
        </span>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section header
// ─────────────────────────────────────────────────────────────────────────
function SectionHeader({ title, subtitle, right }: {
  title: string; subtitle?: string; right?: React.ReactNode;
}) {
  return (
    <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontFamily: UI, fontSize: 14, fontWeight: 600, color: "var(--fg0)", letterSpacing: -0.1 }}>
        {title}
      </h2>
      {subtitle && <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg2)" }}>{subtitle}</span>}
      <div style={{ flex: 1, height: 1, background: "var(--line2)" }} />
      {right}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Recent files — grid card
// ─────────────────────────────────────────────────────────────────────────
function RecentCard({ file, onOpen, starred, archived, onToggleStar, onToggleArchive }: {
  file: RecentFile; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
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
      {/* Thumbnail */}
      <div style={{
        position: "relative", aspectRatio: "0.77 / 1", width: "100%",
        borderRadius: 3, overflow: "hidden",
        border: "1px solid var(--line)", background: "var(--bg2)",
      }}>
        {thumb ? (
          <img
            src={thumb}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            alt=""
          />
        ) : (
          <>
            <div style={{
              position: "absolute", inset: 0,
              background: "repeating-linear-gradient(180deg, transparent 0 8px, var(--line2) 8px 9px)",
            }} />
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "34%", background: swatch }} />
            <div style={{
              position: "absolute", top: 7, left: 7,
              fontFamily: MONO, fontSize: 8, color: "rgba(255,255,255,0.85)",
              letterSpacing: 1, textTransform: "uppercase",
            }}>{ext}</div>
          </>
        )}
        {/* Title chip */}
        <div style={{
          position: "absolute", bottom: 7, left: 7, right: 7,
          fontFamily: UI, fontSize: 10.5, fontWeight: 600, color: "var(--fg0)",
          background: "var(--bg2)", padding: "3px 5px", borderRadius: 2,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          border: "1px solid var(--line)",
        }}>
          {file.name.replace(/\.pdf$/i, "")}
        </div>
        {/* Action buttons — visible on hover */}
        {hover && (
          <div style={{
            position: "absolute", top: 5, right: 5,
            display: "flex", flexDirection: "column", gap: 3,
          }}>
            {onToggleStar && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
                title={starred ? "Unstar" : "Star"}
                style={{
                  width: 22, height: 22, border: "none", borderRadius: 3, cursor: "pointer",
                  background: starred ? "var(--accent)" : "var(--bg2)",
                  color: starred ? "#fff" : "var(--fg1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                }}
              >
                <IcStar size={11} />
              </button>
            )}
            {onToggleArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
                title={archived ? "Unarchive" : "Archive"}
                style={{
                  width: 22, height: 22, border: "none", borderRadius: 3, cursor: "pointer",
                  background: archived ? "var(--bg3)" : "var(--bg2)",
                  color: "var(--fg1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                }}
              >
                <IcArchive size={11} />
              </button>
            )}
          </div>
        )}
      </div>
      {/* Metadata */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 2px" }}>
        <div style={{
          fontFamily: UI, fontSize: 12, fontWeight: 500, color: "var(--fg0)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{file.name.replace(/\.pdf$/i, "")}</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>
          {formatRelativeTime(file.openedAt)}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Recent files — list row
// ─────────────────────────────────────────────────────────────────────────
function RecentList({ files, onOpen, entryMap, onToggleStar, onToggleArchive }: {
  files: RecentFile[];
  onOpen: (f: RecentFile) => void;
  entryMap?: Map<string, LibraryEntry>;
  onToggleStar?: (f: RecentFile) => void;
  onToggleArchive?: (f: RecentFile) => void;
}) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg1)", overflow: "hidden" }}>
      <div style={{
        display: "grid", gridTemplateColumns: "24px 1fr 120px 52px",
        padding: "7px 14px", gap: 12,
        fontFamily: MONO, fontSize: 10, textTransform: "uppercase",
        letterSpacing: 0.6, color: "var(--fg2)",
        borderBottom: "1px solid var(--line2)",
      }}>
        <span />
        <span>Name</span>
        <span>Modified</span>
        <span />
      </div>
      {files.map((f, i) => (
        <ListRow
          key={f.path}
          file={f}
          swatch={fileSwatch(f.name)}
          index={i}
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

function ListRow({ file, swatch, index, onOpen, starred, archived, onToggleStar, onToggleArchive }: {
  file: RecentFile; swatch: string; index: number; onOpen: () => void;
  starred?: boolean; archived?: boolean;
  onToggleStar?: () => void; onToggleArchive?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const iconBtn = (active: boolean, title: string, Icon: (p: IconProps) => React.ReactElement, onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      style={{
        width: 22, height: 22, border: "none", borderRadius: 3, cursor: "pointer",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--fg2)",
        display: "flex", alignItems: "center", justifyContent: "center",
        opacity: hover || active ? 1 : 0,
        transition: "opacity 80ms",
      }}
    >
      <Icon size={11} />
    </button>
  );
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid", gridTemplateColumns: "24px 1fr 120px 52px",
        padding: "8px 14px", gap: 12, alignItems: "center",
        background: hover ? "var(--bg2)" : "transparent",
        border: "none",
        borderTop: index === 0 ? "none" : "1px solid var(--line2)",
        width: "100%", textAlign: "left", cursor: "pointer",
        transition: "background 80ms",
      }}
    >
      <span style={{ width: 18, height: 22, background: swatch, borderRadius: 2, display: "inline-block" }} />
      <span style={{ fontFamily: UI, fontSize: 12.5, color: "var(--fg0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {file.name}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg1)" }}>
        {formatRelativeTime(file.openedAt)}
      </span>
      <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
        {onToggleStar && iconBtn(starred ?? false, starred ? "Unstar" : "Star", IcStar, onToggleStar)}
        {onToggleArchive && iconBtn(archived ?? false, archived ? "Unarchive" : "Archive", IcArchive, onToggleArchive)}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// View toggle pill + segment pill
// ─────────────────────────────────────────────────────────────────────────
function ViewToggle({ mode, setMode }: { mode: "grid" | "list"; setMode: (m: "grid" | "list") => void }) {
  const btn = (m: "grid" | "list", Icon: (p: IconProps) => React.ReactElement) => (
    <button onClick={() => setMode(m)} style={{
      width: 22, height: 22, border: "none",
      background: mode === m ? "var(--bg3)" : "transparent",
      color: mode === m ? "var(--fg0)" : "var(--fg2)",
      borderRadius: 3, cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      transition: "background 80ms",
    }}>
      <Icon size={13} />
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {btn("grid", IcGrid)}
      {btn("list", IcList)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Empty-state illustration
// ─────────────────────────────────────────────────────────────────────────
function EmptyRecents() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 10,
      padding: "40px 24px",
      border: "1px dashed var(--line)", borderRadius: 6,
      background: "var(--bg1)",
    }}>
      <IcFile size={28} style={{ color: "var(--fg3)" }} />
      <div style={{ fontFamily: UI, fontSize: 13, color: "var(--fg2)", textAlign: "center" }}>
        No recent files — open a PDF to get started.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Home page
// ─────────────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function Home() {
  const navigate = useNavigate();
  const { setViewerFile } = useAppStore();
  const [dragging, setDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<Section>("home");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const { data: diskSpaceData } = useDiskSpace();
  const storageUsage = diskSpaceData ?? null;
  const { data: starredFiles = [] } = useStarred();
  const { data: archivedFiles = [] } = useArchived();
  const setStarredMutation = useSetStarred();
  const setArchivedMutation = useSetArchived();

  const entryMap = useMemo(() => {
    const m = new Map<string, LibraryEntry>();
    for (const e of starredFiles) m.set(e.path, e);
    for (const e of archivedFiles) {
      const existing = m.get(e.path);
      m.set(e.path, existing ? { ...existing, archived: true } : e);
    }
    return m;
  }, [starredFiles, archivedFiles]);

  function toggleStar(file: RecentFile) {
    const cur = entryMap.get(file.path);
    setStarredMutation.mutate({ path: file.path, name: file.name, starred: !(cur?.starred ?? false) });
  }

  function toggleArchive(file: RecentFile) {
    const cur = entryMap.get(file.path);
    setArchivedMutation.mutate({ path: file.path, name: file.name, archived: !(cur?.archived ?? false) });
  }

  useEffect(() => { setRecentFiles(loadRecent()); }, []);

  // ⌘O shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); handleBrowse(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function openPdf(rawPath: string) {
    const name = await getDisplayName(rawPath);
    setLoading(name);
    const path = await resolveAndroidUri(rawPath).catch(() => rawPath);
    setViewerFile({ path, name });
    addToRecent(path, name);
    setRecentFiles(loadRecent());
    navigate("/view");
  }

  const handleBrowse = useCallback(async () => {
    try {
      if (isAndroid()) {
        const picked = await pickFilesAndroid("application/pdf,.pdf", false);
        if (!picked.length) return;
        const { path, name } = picked[0];
        setLoading(name);
        setViewerFile({ path, name });
        addToRecent(path, name);
        navigate("/view");
        return;
      }
      const selected = await open({ multiple: false, filters: [{ name: "PDF Files", extensions: ["pdf"] }] });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      await openPdf(path);
    } catch { /* dismissed */ }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const handleDragLeave = useCallback(() => setDragging(false), []);
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
  }, []);

  // Tauri v2: use onDragDropEvent for actual file system paths (file.path doesn't exist in webview)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const webview = getCurrentWebviewWindow();
        unlisten = await webview.onDragDropEvent(async (event) => {
          if (event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            const paths = event.payload.paths;
            if (paths.length > 0) await openPdf(paths[0]);
          }
        });
      } catch {
        // Not in Tauri — HTML drag events remain as fallback
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  function handleRailPick(id: string) {
    if (id === "merge") { navigate("/merge"); return; }
    if (id === "i2pdf") { navigate("/images-to-pdf"); return; }
    if (id === "local") { handleBrowse(); return; }
    setActiveSection(id as Section);
  }

  const nonArchived = recentFiles.filter(f => !entryMap.get(f.path)?.archived);
  const displayFiles: RecentFile[] =
    activeSection === "recent" ? nonArchived
    : activeSection === "home" ? nonArchived.slice(0, 6)
    : activeSection === "starred" ? starredFiles.map(e => ({ path: e.path, name: e.name, openedAt: e.addedAt }))
    : activeSection === "archive" ? archivedFiles.map(e => ({ path: e.path, name: e.name, openedAt: e.addedAt }))
    : [];

  const recentCount = recentFiles.length;
  const fileLabel = `${String(displayFiles.length).padStart(2, "0")} files`;

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg0)", overflow: "hidden" }}>
      <LeftRail active={activeSection} onPick={handleRailPick} recentCount={recentCount} storageUsage={storageUsage} />

      {/* Main canvas */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Status strip */}
        <div style={{
          height: 32, flexShrink: 0,
          borderBottom: "1px solid var(--line2)",
          display: "flex", alignItems: "center",
          padding: "0 16px", gap: 12,
          fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)",
        }}>
          <span style={{ color: "var(--fg1)" }}>~/</span>
          <span>Home</span>
          <IcChevron size={10} />
          <span>Library overview</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg2)" }}>{recentCount} documents</span>
          <span style={{ color: "var(--fg3)" }}>·</span>
          <span style={{ color: "var(--fg2)" }}>local storage</span>
          <div style={{ width: 1, height: 14, background: "var(--line)" }} />
          <ViewToggle mode={viewMode} setMode={setViewMode} />
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 24px 32px" }}>
          <div style={{ maxWidth: 1200, display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Hero drop zone */}
            <DropHero
              drag={dragging}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleBrowse}
              loading={loading}
            />

            {/* Quick actions */}
            <section>
              <SectionHeader title="Quick actions" subtitle="02 tools" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                <QuickToolCard
                  Icon={IcMerge}
                  title="Merge PDFs"
                  desc="Combine multiple PDFs into a single document. Drag to reorder before export."
                  shortcut="⌘M"
                  meta="Up to 100 files"
                  onClick={() => navigate("/merge")}
                />
                <QuickToolCard
                  Icon={IcImage}
                  title="Images → PDF"
                  desc="Bundle JPG, PNG, HEIC, or WebP into a paginated PDF. Set size & margin."
                  shortcut="⌘I"
                  meta="JPG · PNG · HEIC · WebP"
                  onClick={() => navigate("/images-to-pdf")}
                />
              </div>
            </section>

            {/* Recents */}
            <section>
              <SectionHeader
                title={
                  activeSection === "recent" ? "All recents" :
                  activeSection === "starred" ? "Starred" :
                  activeSection === "archive" ? "Archive" :
                  "Recents"
                }
                subtitle={displayFiles.length > 0 ? fileLabel : undefined}
                right={
                  recentFiles.length > 6 && activeSection === "home" ? (
                    <button
                      onClick={() => setActiveSection("recent")}
                      style={{
                        background: "transparent", border: "none",
                        color: "var(--fg1)", fontFamily: UI, fontSize: 11.5,
                        fontWeight: 500, cursor: "pointer",
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "4px 6px",
                      }}
                    >
                      View all <IcChevron size={11} />
                    </button>
                  ) : undefined
                }
              />
              {displayFiles.length === 0 ? (
                activeSection === "home" || activeSection === "recent" ? <EmptyRecents /> : (
                  <div style={{
                    display: "flex", flexDirection: "column", alignItems: "center",
                    justifyContent: "center", gap: 10,
                    padding: "40px 24px",
                    border: "1px dashed var(--line)", borderRadius: 6,
                    background: "var(--bg1)",
                  }}>
                    <IcFolder size={28} style={{ color: "var(--fg3)" }} />
                    <div style={{ fontFamily: UI, fontSize: 13, color: "var(--fg2)", textAlign: "center" }}>
                      {activeSection === "starred" ? "No starred files yet." :
                       activeSection === "archive" ? "No archived files." : "This section is empty."}
                    </div>
                  </div>
                )
              ) : viewMode === "grid" ? (
                <div style={{
                  display: "grid", gap: 12,
                  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                }}>
                  {displayFiles.map((f) => (
                    <RecentCard
                      key={f.path}
                      file={f}
                      onOpen={() => openPdf(f.path)}
                      starred={entryMap.get(f.path)?.starred ?? false}
                      archived={entryMap.get(f.path)?.archived ?? false}
                      onToggleStar={() => toggleStar(f)}
                      onToggleArchive={() => toggleArchive(f)}
                    />
                  ))}
                </div>
              ) : (
                <RecentList
                  files={displayFiles}
                  onOpen={(f) => openPdf(f.path)}
                  entryMap={entryMap}
                  onToggleStar={toggleStar}
                  onToggleArchive={toggleArchive}
                />
              )}
            </section>

          </div>
        </div>
      </main>
    </div>
  );
}
