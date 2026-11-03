import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/useAppStore";
import type { LibraryEntry, RecentFile } from "../lib/schemas";
import { RecentFileSchema } from "../lib/schemas";
import { useStarred, useArchived, useSetStarred, useSetArchived } from "../lib/queries";
import { IcAlert, IcClose } from "../components/Icons";
import { LeftRail } from "./home/LeftRail";
import { DropCounter } from "./home/DropHero";
import { SectionHead, ViewToggle, EmptyShelf, ToolCardItem, FamilyNote, SheetCard, SheetList, ViewAll } from "./home/RecentFiles";
import { STANDALONE_TOOLS, IN_DOCUMENT } from "./home/tools";
import { matchHomeShortcut } from "./home/shortcuts";
import type { Section } from "./home/types";

const RECENT_KEY = "qyra-recent";
const MAX_RECENT = 12;
const HOME_SHELF = 8;

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

function displayName(rawPath: string): string {
  return rawPath.split(/[\\/]/).pop() ?? rawPath;
}

const SECTION_TITLE: Record<Section, string> = {
  home: "Home",
  recent: "Recents",
  starred: "Starred",
  local: "Home",
  archive: "Archive",
};

interface HomeProps {
  onOpenPdf?: (path: string, name: string) => void;
}

export default function Home({ onOpenPdf }: HomeProps = {}) {
  const navigate = useNavigate();
  // All actions (stable refs) — selecting them individually means Home never
  // re-renders from store writes (a bare useAppStore() re-renders on every write).
  const openTab = useAppStore((s) => s.openTab);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);
  const [dragging, setDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<Section>("home");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = matchHomeShortcut(e);
      if (!action) return;
      e.preventDefault();
      if (action === "browse") handleBrowse();
      else navigate(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function openPdf(path: string) {
    setFileError(null);
    const name = displayName(path);

    if (!name.toLowerCase().endsWith(".pdf")) {
      setFileError(`"${name}" is not a PDF file.`);
      return;
    }

    setLoading(name);
    addToRecent(path, name);
    setRecentFiles(loadRecent());

    if (onOpenPdf) {
      onOpenPdf(path, name);
      setLoading(null);
      return;
    }

    openTab({ type: "pdf", path, name });
    setTabOriginal(path, path);
    setTabDirty(path, false);
    setTabUndo(path, null);
    navigate("/view");
  }

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "PDF Files", extensions: ["pdf"] }] });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0]! : selected;
      await openPdf(path);
    } catch { /* dismissed */ }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const handleDragLeave = useCallback(() => setDragging(false), []);
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
  }, []);

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
            if (paths.length > 0) await openPdf(paths[0]!);
          }
        });
      } catch {
        // Not in Tauri — HTML drag events remain as fallback
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  function handleRailPick(id: string) {
    if (id === "local") { handleBrowse(); return; }
    setActiveSection(id as Section);
  }

  const nonArchived = recentFiles.filter(f => !entryMap.get(f.path)?.archived);
  const shelf: RecentFile[] =
    activeSection === "recent" ? nonArchived
    : activeSection === "starred" ? starredFiles.map(e => ({ path: e.path, name: e.name, openedAt: e.addedAt }))
    : activeSection === "archive" ? archivedFiles.map(e => ({ path: e.path, name: e.name, openedAt: e.addedAt }))
    : nonArchived.slice(0, HOME_SHELF);

  const isHome = activeSection === "home" || activeSection === "local";
  const shelfTitle = activeSection === "recent" ? "All recents" : activeSection === "starred" ? "Starred" : activeSection === "archive" ? "Archive" : "Recents";
  const shelfMeta = shelf.length > 0 ? `${shelf.length} ${shelf.length === 1 ? "file" : "files"}` : undefined;
  const last = nonArchived[0] ?? null;

  return (
    <div className="home">
      <LeftRail
        active={activeSection}
        onPick={handleRailPick}
        recentCount={nonArchived.length}
        starredCount={starredFiles.length}
        archivedCount={archivedFiles.length}
      />

      <main className="home-main">
        <div className="panel-head">
          <span className="panel-title">{SECTION_TITLE[activeSection]}</span>
          <span className="t-meta">{nonArchived.length} {nonArchived.length === 1 ? "document" : "documents"} · local only</span>
          <span style={{ flex: 1 }} />
          <ViewToggle mode={viewMode} setMode={setViewMode} />
        </div>

        <div className="home-scroll">
          {fileError && (
            <div role="alert" className="alert">
              <IcAlert size={16} />
              <span style={{ flex: 1 }}>{fileError}</span>
              <button type="button" className="btn-icon" style={{ width: 28, height: 28 }} onClick={() => setFileError(null)} aria-label="Dismiss error">
                <IcClose size={14} />
              </button>
            </div>
          )}

          {isHome && (
            <DropCounter
              drag={dragging}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onOpen={handleBrowse}
              loading={loading}
              last={last}
              onContinue={(f) => openPdf(f.path)}
            />
          )}

          {isHome && (
            <section className="section">
              <SectionHead title="Tools" meta={`${STANDALONE_TOOLS.length} tools`} />
              <div className="tool-grid">
                {STANDALONE_TOOLS.map((t) => (
                  <ToolCardItem key={t.id} tool={t} onClick={() => navigate(t.route)} />
                ))}
              </div>
              <div className="family-row" aria-label="What you can do inside a document">
                <span className="t-meta family-row-lead">In a document:</span>
                {IN_DOCUMENT.map((f) => (
                  <FamilyNote key={f.family} family={f.family} note={f.note} onClick={handleBrowse} />
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <SectionHead
              title={shelfTitle}
              meta={shelfMeta}
              right={isHome && nonArchived.length > HOME_SHELF ? <ViewAll onClick={() => setActiveSection("recent")} /> : undefined}
            />
            {shelf.length === 0 ? (
              activeSection === "starred" ? <EmptyShelf title="Nothing starred yet" note="Star a sheet from Recents to keep it here." />
              : activeSection === "archive" ? <EmptyShelf title="The archive is empty" note="Archive a sheet to move it out of Recents without losing it." />
              : <EmptyShelf title="No sheets on the shelf yet" note="Open a PDF and it will appear here, with its page count and size." />
            ) : viewMode === "grid" ? (
              <div className="sheet-grid">
                {shelf.map((f) => (
                  <SheetCard
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
              <SheetList
                files={shelf}
                onOpen={(f) => openPdf(f.path)}
                entryMap={entryMap}
                onToggleStar={toggleStar}
                onToggleArchive={toggleArchive}
              />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
