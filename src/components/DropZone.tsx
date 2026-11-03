import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getPdfInfo } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { IcUpload } from "./Icons";

interface DropZoneProps {
  accept?: string[];
  multiple?: boolean;
  label?: string;
}

/** A smaller counter for the tool pages: drop files here, or click to browse. */
export function DropZone({ accept = [".pdf"], multiple = true, label }: DropZoneProps) {
  // Action selectors are stable references, so this component never re-renders
  // from store writes (a bare useAppStore() would re-render on every write).
  const addFile = useAppStore((s) => s.addFile);
  const setError = useAppStore((s) => s.setError);
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

  const kinds = accept.includes(".pdf") ? (multiple ? "PDF files" : "a PDF") : (multiple ? "images" : "an image");
  const text = label ?? `Drop ${kinds} here, or click to browse`;

  return (
    <div
      ref={containerRef}
      role="button"
      tabIndex={0}
      aria-label={text}
      className="dropzone"
      data-drag={dragging ? "true" : undefined}
      onClick={handleBrowse}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleBrowse(); } }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <span className="dropzone-icon" aria-hidden="true"><IcUpload size={20} /></span>
      <span className="dropzone-text">{dragging ? "Let go to add" : text}</span>
      <span className="t-meta">Files never leave this computer</span>
    </div>
  );
}
