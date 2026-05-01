import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getPdfInfo } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

interface DropZoneProps {
  accept?: string[];
  multiple?: boolean;
  label?: string;
}

export function DropZone({ accept = [".pdf"], multiple = true, label }: DropZoneProps) {
  const { addFile, setError } = useAppStore();
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  async function handlePaths(paths: string[]) {
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      try {
        const info = await getPdfInfo(path);
        addFile({ path, name, info });
      } catch {
        addFile({ path, name });
      }
    }
  }

  const handleBrowse = useCallback(async () => {
    try {
      if (isAndroid()) {
        const mimeAccept = accept.includes(".pdf")
          ? "application/pdf,.pdf"
          : "image/png,image/jpeg,image/webp,.heic";
        const picked = await pickFilesAndroid(mimeAccept, multiple);
        if (!picked.length) return;
        await handlePaths(picked.map((f) => f.path));
        return;
      }
      const selected = await open({
        multiple,
        filters: accept.includes(".pdf")
          ? [{ name: "PDF Files", extensions: ["pdf"] }]
          : [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await handlePaths(paths);
    } catch (e) {
      setError(String(e));
    }
  }, [multiple, accept]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  // Tauri v2: use onDragDropEvent for actual file system paths (file.path doesn't exist in webview)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const webview = getCurrentWebviewWindow();
        unlisten = await webview.onDragDropEvent(async (event) => {
          const el = containerRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const pos = (event.payload as any).position;
          const isOver = pos
            ? pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom
            : false;

          if (event.payload.type === "over") {
            setDragging(isOver);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop" && isOver) {
            setDragging(false);
            const paths = (event.payload as any).paths as string[];
            const filtered = multiple ? paths : paths.slice(0, 1);
            if (filtered.length > 0) await handlePaths(filtered);
          }
        });
      } catch {
        // Not in Tauri — HTML drag events remain as fallback
      }
    })();
    return () => { unlisten?.(); };
  }, [accept, multiple]);

  return (
    <div
      ref={containerRef}
      onClick={handleBrowse}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        position: "relative", borderRadius: 6,
        border: `1px ${dragging ? "solid" : "dashed"} ${dragging ? "var(--accent)" : "var(--line)"}`,
        background: dragging ? "var(--accent-soft)" : "var(--bg1)",
        padding: "32px 24px", textAlign: "center", cursor: "pointer",
        transition: "all 120ms ease",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (!dragging) (e.currentTarget as HTMLDivElement).style.borderColor = "var(--fg2)";
      }}
      onMouseLeave={(e) => {
        if (!dragging) (e.currentTarget as HTMLDivElement).style.borderColor = "var(--line)";
      }}
    >
      {/* Subtle stripe */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        opacity: dragging ? 0.12 : 0.03,
        background: "repeating-linear-gradient(45deg, transparent 0 11px, var(--fg1) 11px 12px)",
        transition: "opacity 120ms",
      }} />

      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <svg width={32} height={32} fill="none" stroke="currentColor" strokeWidth={1.5}
          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
          style={{ color: dragging ? "var(--accent)" : "var(--fg2)" }}>
          <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <div>
          <p style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, fontWeight: 500, color: "var(--fg0)", margin: 0 }}>
            {label ?? `Drop ${accept.join(", ")} files here or click to browse`}
          </p>
          <p style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10.5, color: "var(--fg2)", margin: "4px 0 0" }}>
            Files never leave your device
          </p>
        </div>
      </div>
    </div>
  );
}
