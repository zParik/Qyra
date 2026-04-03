import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { useAppStore } from "../store/useAppStore";
import { getPdfInfo, getContentUriDisplayName } from "../lib/tauri";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

const RECENT_KEY = "quire-recent";
const MAX_RECENT = 8;

function loadRecent(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
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
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * On Android, the dialog plugin returns content:// URIs which Rust's std::fs cannot read.
 * This copies the file to the app cache dir and returns the real file system path.
 * On other platforms, returns the path unchanged.
 */
async function resolveAndroidUri(rawPath: string): Promise<string> {
  if (!rawPath.startsWith("content://")) return rawPath;
  const bytes = await readFile(rawPath);
  const cacheDir = await appCacheDir();
  const tmpPath = await join(cacheDir, `na_${Date.now()}.pdf`);
  await writeFile(tmpPath, bytes);
  return tmpPath;
}

/** Get display name for a path or content URI. Uses ContentResolver on Android for content:// URIs. */
async function getDisplayName(rawPath: string): Promise<string> {
  if (rawPath.startsWith("content://")) {
    try {
      return await getContentUriDisplayName(rawPath);
    } catch {
      // fallback: try to extract from URI
      const decoded = decodeURIComponent(rawPath);
      const match = decoded.match(/([^/\\:]+\.pdf)(?:[?#]|$)/i);
      return match ? match[1] : "document.pdf";
    }
  }
  return rawPath.split(/[\\/]/).pop() ?? rawPath;
}

export default function Home() {
  const navigate = useNavigate();
  const { setViewerFile } = useAppStore();
  const [dragging, setDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState<string | null>(null); // filename being opened

  useEffect(() => {
    setRecentFiles(loadRecent());
  }, []);

  async function openPdf(rawPath: string) {
    const name = await getDisplayName(rawPath);
    setLoading(name);
    // Resolve Android content:// URIs to a real temp file path before invoking Rust commands
    const path = await resolveAndroidUri(rawPath).catch(() => rawPath);
    try {
      const info = await getPdfInfo(path);
      setViewerFile({ path, name, info });
    } catch {
      setViewerFile({ path, name });
    }
    addToRecent(path, name);
    navigate("/view");
  }

  const handleBrowse = useCallback(async () => {
    try {
      if (isAndroid()) {
        const picked = await pickFilesAndroid("application/pdf,.pdf", false);
        if (!picked.length) return;
        // Files are already in app cache dir; name was resolved from the File object
        const { path, name } = picked[0];
        setLoading(name);
        try {
          const info = await getPdfInfo(path);
          setViewerFile({ path, name, info });
        } catch {
          setViewerFile({ path, name });
        }
        addToRecent(path, name);
        navigate("/view");
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      await openPdf(path);
    } catch {
      // dismissed
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths: string[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const file = item.getAsFile();
      if (file && (file as any).path) paths.push((file as any).path);
    }
    if (paths.length > 0) await openPdf(paths[0]);
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "var(--app-bg)" }}
    >
      {/* Header */}
      <header
        className="border-b px-6"
        style={{
          background: "var(--app-surface)",
          borderColor: "var(--app-border)",
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.875rem)",
          paddingBottom: "0.875rem",
        }}
      >
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Brand mark */}
            <div
              className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
              style={{ background: "var(--brand)" }}
            >
              <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="flex items-baseline gap-2.5">
              <span
                className="font-bold text-sm tracking-tight"
                style={{ color: "var(--text-primary)" }}
              >
                Quire
              </span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                Free · Offline · Open Source
              </span>
            </div>
          </div>

          {/* Privacy note — quiet, not a badge */}
          <div
            className="flex items-center gap-1.5 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                clipRule="evenodd"
              />
            </svg>
            Files never leave your device
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl space-y-5">
          {/* Drop zone — shows loading state while getPdfInfo runs */}
          {loading ? (
            <div
              className="border-2 border-dashed rounded-xl p-8 sm:p-14 text-center"
              style={{ borderColor: "var(--app-border)" }}
            >
              <div className="flex flex-col items-center gap-4">
                {/* Spinning ring */}
                <div className="relative w-14 h-14">
                  <svg
                    className="w-14 h-14 animate-spin"
                    style={{ color: "var(--action)" }}
                    viewBox="0 0 56 56"
                    fill="none"
                  >
                    <circle
                      cx="28" cy="28" r="22"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeOpacity="0.15"
                    />
                    <path
                      d="M28 6a22 22 0 0 1 22 22"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <svg
                      className="w-6 h-6"
                      style={{ color: "var(--text-muted)" }}
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  </div>
                </div>
                <div>
                  <p className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                    Opening…
                  </p>
                  <p
                    className="text-sm mt-1 max-w-xs mx-auto truncate"
                    style={{ color: "var(--text-muted)" }}
                    title={loading}
                  >
                    {loading}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div
              onClick={handleBrowse}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className="drop-zone border-2 border-dashed rounded-xl p-8 sm:p-14 text-center cursor-pointer"
              style={dragging ? { borderColor: "var(--action)", background: "var(--app-surface)" } : {}}
            >
              <div className="flex flex-col items-center gap-4">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center transition-colors"
                  style={{
                    background: dragging ? "var(--action)" : "var(--app-surface)",
                    color: dragging ? "var(--action-text)" : "var(--text-muted)",
                  }}
                >
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                </div>
                <div>
                  <p
                    className="text-base font-semibold"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {dragging ? "Drop to open" : "Open a PDF"}
                  </p>
                  <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
                    Drop a file here, or click to browse
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Secondary tools — text-forward, no card grid */}
          <div
            className="rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--app-border)" }}
          >
            <button
              onClick={() => navigate("/merge")}
              className="row-btn w-full flex items-center justify-between px-4 py-3 text-left"
              style={{ borderBottom: "1px solid var(--app-border)" }}
            >
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Merge PDFs
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Combine multiple files into one
                </p>
              </div>
              <svg
                className="w-4 h-4 shrink-0"
                style={{ color: "var(--text-muted)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            <button
              onClick={() => navigate("/images-to-pdf")}
              className="row-btn w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <div>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Images to PDF
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  Convert photos and images to a PDF
                </p>
              </div>
              <svg
                className="w-4 h-4 shrink-0"
                style={{ color: "var(--text-muted)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Recent files */}
          {recentFiles.length > 0 && (
            <div>
              <h2
                className="text-xs mb-2"
                style={{ color: "var(--text-muted)" }}
              >
                Recent
              </h2>
              <div className="space-y-0.5">
                {recentFiles.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => openPdf(file.path)}
                    className="row-btn w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left"
                  >
                    <svg
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--brand)" }}
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <span
                      className="flex-1 text-sm truncate transition-colors"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {file.name}
                    </span>
                    <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
                      {formatRelativeTime(file.openedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
