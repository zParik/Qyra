import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { useAppStore } from "../store/useAppStore";
import { getContentUriDisplayName } from "../lib/tauri";
import type { LibraryEntry, RecentFile } from "../lib/schemas";
import { RecentFileSchema } from "../lib/schemas";
import { useDiskSpace, useStarred, useArchived, useSetStarred, useSetArchived } from "../lib/queries";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

import { UI, MONO } from "../lib/tokens";
import { IcChevron, IcMerge, IcImage, IcFolder } from "../components/Icons";
import { LeftRail } from "./home/LeftRail";
import { BottomTabBar } from "./home/BottomTabBar";
import { DropHero } from "./home/DropHero";
import { SectionHeader, ViewToggle, EmptyRecents, QuickToolCard, RecentCard, RecentList } from "./home/RecentFiles";
import type { Section } from "./home/types";

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
      return match ? match[1]! : "document.pdf";
    }
  }
  return rawPath.split(/[\\/]/).pop() ?? rawPath;
}

interface HomeProps {
  onOpenPdf?: (path: string, name: string) => void;
}

export default function Home({ onOpenPdf }: HomeProps = {}) {
  const navigate = useNavigate();
  const { openTab, setTabOriginal, setTabDirty, setTabUndo } = useAppStore();
  const [dragging, setDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<Section>("home");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
  const { data: diskSpaceData } = useDiskSpace();
  const storageUsage = diskSpaceData ?? null;
  const { data: starredFiles = [] } = useStarred();
  const { data: archivedFiles = [] } = useArchived();
  const setStarredMutation = useSetStarred();
  const setArchivedMutation = useSetArchived();

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); handleBrowse(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function openPdf(rawPath: string) {
    setFileError(null);
    const name = await getDisplayName(rawPath);

    if (!name.toLowerCase().endsWith(".pdf")) {
      setFileError(`"${name}" is not a PDF file.`);
      return;
    }

    setLoading(name);
    const path = await resolveAndroidUri(rawPath).catch(() => rawPath);
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
      if (isAndroid()) {
        const picked = await pickFilesAndroid("application/pdf,.pdf", false);
        if (!picked.length) return;
        const { path: rawPath, name } = picked[0]!;
        setLoading(name);
        const path = await resolveAndroidUri(rawPath).catch(() => rawPath);
        addToRecent(path, name);
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
        return;
      }
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
  const bottomPad = isMobile ? 72 : 32;

  return (
    <div className="flex overflow-hidden" style={{ height: "100dvh", background: "var(--bg0)" }}>
      {!isMobile && (
        <LeftRail active={activeSection} onPick={handleRailPick} recentCount={recentCount} storageUsage={storageUsage} />
      )}

      <main className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {!isMobile && (
          <div className="home-status-strip" style={{ fontFamily: MONO }}>
            <span style={{ color: "var(--fg1)" }}>~/</span>
            <span>Home</span>
            <IcChevron size={10} />
            <span>Library overview</span>
            <span className="flex-1" />
            <span>{recentCount} documents</span>
            <span style={{ color: "var(--fg3)" }}>·</span>
            <span>local storage</span>
            <div className="w-px h-3.5" style={{ background: "var(--line)" }} />
            <ViewToggle mode={viewMode} setMode={setViewMode} />
          </div>
        )}

        {isMobile && (
          <div className="flex items-center justify-between px-4 shrink-0"
            style={{
              height: "calc(48px + env(safe-area-inset-top, 0px))",
              borderBottom: "1px solid var(--line2)",
              paddingTop: "env(safe-area-inset-top, 0px)",
            }}>
            <span className="text-base font-bold" style={{ fontFamily: UI, color: "var(--fg0)" }}>Qyra</span>
            <ViewToggle mode={viewMode} setMode={setViewMode} />
          </div>
        )}

        <div className="flex-1 overflow-auto" style={{ padding: isMobile ? "16px 16px 0" : "20px 24px 0" }}>
          <div className="flex flex-col" style={{ gap: isMobile ? 16 : 24, paddingBottom: bottomPad }}>

            {fileError && (
              <div role="alert" style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px",
                background: "var(--bg1)", border: "1px solid #b94040",
                borderRadius: 6, fontFamily: UI, fontSize: 12.5, color: "#e07070",
              }}>
                <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor"
                  strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11v.5"/>
                </svg>
                <span style={{ flex: 1 }}>{fileError}</span>
                <button
                  onClick={() => setFileError(null)}
                  aria-label="Dismiss error"
                  style={{
                    background: "transparent", border: "none", cursor: "pointer",
                    color: "var(--fg2)", padding: 2, display: "flex", alignItems: "center",
                  }}
                >
                  <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor"
                    strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
                    <path d="M3 3l10 10M13 3L3 13"/>
                  </svg>
                </button>
              </div>
            )}

            <DropHero
              drag={dragging}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleBrowse}
              loading={loading}
              isMobile={isMobile}
            />

            <section>
              <SectionHeader title="Quick actions" subtitle="03 tools" />
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
                gap: isMobile ? 8 : 10,
              }}>
                <QuickToolCard
                  Icon={IcMerge}
                  title="Merge PDFs"
                  desc="Combine multiple PDFs into a single document."
                  shortcut="Cmd+M"
                  meta="Up to 100 files"
                  onClick={() => navigate("/merge")}
                  isMobile={isMobile}
                />
                <QuickToolCard
                  Icon={IcImage}
                  title="Images to PDF"
                  desc="Bundle JPG, PNG, HEIC, or WebP into a paginated PDF."
                  shortcut="Cmd+I"
                  meta="JPG, PNG, HEIC, WebP"
                  onClick={() => navigate("/images-to-pdf")}
                  isMobile={isMobile}
                />
              </div>
            </section>

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
                  display: "grid", gap: isMobile ? 8 : 12,
                  gridTemplateColumns: isMobile
                    ? "repeat(auto-fill, minmax(130px, 1fr))"
                    : "repeat(auto-fill, minmax(160px, 1fr))",
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
                      isMobile={isMobile}
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
                  isMobile={isMobile}
                />
              )}
            </section>

          </div>
        </div>
      </main>

      {isMobile && (
        <BottomTabBar
          active={activeSection}
          onPick={handleRailPick}
          onOpenFile={handleBrowse}
        />
      )}
    </div>
  );
}
