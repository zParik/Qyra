import { useCallback, useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { useAppStore, LoadedFile } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { imagesToPdf } from "../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

import { UI, MONO } from "../lib/tokens";

const SWATCHES = ["#c87a52","#5e7a8a","#7a5e8a","#5e8a7a","#8a7a5e","#5e7a5e"];
function imgSwatch(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return SWATCHES[Math.abs(h) % SWATCHES.length]!;
}

export default function ImagesToPdf() {
  const files = useAppStore((s) => s.files);
  const addFile = useAppStore((s) => s.addFile);
  const removeFile = useAppStore((s) => s.removeFile);
  const clearFiles = useAppStore((s) => s.clearFiles);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const reset = useAppStore((s) => s.reset);

  useEffect(() => { clearFiles(); reset(); }, []);
  const { run } = usePdfCommand();

  const handleBrowse = useCallback(async () => {
    if (isAndroid()) {
      const picked = await pickFilesAndroid("image/png,image/jpeg,image/webp", true);
      for (const { path, name } of picked) addFile({ path, name } as LoadedFile);
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      addFile({ path, name } as LoadedFile);
    }
  }, []);

  async function handleConvert() {
    if (files.length === 0) return;
    await run(() => imagesToPdf(files.map((f) => f.path)));
  }

  return (
    <ToolLayout title="Images → PDF" description="Bundle PNG, JPG, or WebP images into a PDF">
      {/* Drop zone */}
      <div
        onClick={handleBrowse}
        style={{
          borderRadius: 6, border: "1px dashed var(--line)",
          background: "var(--bg1)", padding: "28px 24px",
          textAlign: "center", cursor: "pointer",
          transition: "all 120ms ease",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = "var(--fg2)";
          (e.currentTarget as HTMLDivElement).style.background = "var(--bg2)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = "var(--line)";
          (e.currentTarget as HTMLDivElement).style.background = "var(--bg1)";
        }}
      >
        <svg width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.5}
          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
          style={{ color: "var(--fg2)" }}>
          <rect x="2.5" y="3" width="11" height="10" rx="0.5" />
          <circle cx="6" cy="6.5" r="1" />
          <path d="M3 11l3-3 3 3 2-2 2 2" />
        </svg>
        <div>
          <p style={{ fontFamily: UI, fontSize: 13, fontWeight: 500, color: "var(--fg0)", margin: 0 }}>
            Drop images here or click to browse
          </p>
          <p style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", margin: "4px 0 0" }}>
            JPG · PNG · WebP supported
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg1)" }}>
              {files.length} image{files.length !== 1 ? "s" : ""} queued
            </span>
            <button
              onClick={clearFiles}
              style={{
                background: "transparent", border: "none",
                fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)", cursor: "pointer", padding: 0,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--fg2)")}
            >
              Clear all
            </button>
          </div>

          {/* Image list */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
            {files.map((file, i) => (
              <div key={file.path} style={{
                position: "relative", aspectRatio: "1 / 1.1",
                background: imgSwatch(file.name), borderRadius: 4,
                overflow: "hidden", border: "1px solid var(--line)",
              }}>
                <div style={{
                  position: "absolute", inset: 0,
                  background: "repeating-linear-gradient(45deg, transparent 0 6px, rgba(255,255,255,0.06) 6px 7px)",
                }} />
                <div style={{
                  position: "absolute", top: 5, left: 6,
                  fontFamily: MONO, fontSize: 8.5, color: "rgba(255,255,255,0.85)",
                }}>
                  {String(i + 1).padStart(3, "0")}
                </div>
                <div style={{
                  position: "absolute", bottom: 5, left: 6, right: 24,
                  fontFamily: UI, fontSize: 9.5, color: "rgba(255,255,255,0.8)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {file.name}
                </div>
                <button
                  onClick={() => removeFile(file.path)}
                  style={{
                    position: "absolute", top: 4, right: 4,
                    background: "rgba(0,0,0,0.35)", border: "none", borderRadius: 3,
                    width: 18, height: 18, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "rgba(255,255,255,0.85)",
                  }}
                >
                  <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2}
                    strokeLinecap="round" viewBox="0 0 16 16">
                    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
                  </svg>
                </button>
              </div>
            ))}
            {/* Add more */}
            <button
              onClick={handleBrowse}
              style={{
                aspectRatio: "1 / 1.1", background: "var(--bg2)",
                border: "1px dashed var(--line)", borderRadius: 4, color: "var(--fg2)",
                cursor: "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 4,
                fontFamily: UI, fontSize: 11,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--fg2)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}
            >
              <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5}
                strokeLinecap="round" viewBox="0 0 16 16">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Add
            </button>
          </div>

          <button
            disabled={isProcessing}
            onClick={handleConvert}
            style={{
              background: isProcessing ? "var(--action-dim)" : "var(--accent)",
              color: "var(--accent-text)",
              border: "none", borderRadius: 4, padding: "0 16px", height: 32,
              fontFamily: UI, fontSize: 13, fontWeight: 600,
              cursor: isProcessing ? "not-allowed" : "pointer",
              width: "100%", transition: "background 120ms",
            }}
          >
            Create PDF from {files.length} image{files.length !== 1 ? "s" : ""}
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
