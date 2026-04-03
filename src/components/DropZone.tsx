import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getPdfInfo } from "../lib/tauri";
import { useAppStore, LoadedFile } from "../store/useAppStore";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

interface DropZoneProps {
  accept?: string[];
  multiple?: boolean;
  label?: string;
}

export function DropZone({ accept = [".pdf"], multiple = true, label }: DropZoneProps) {
  const { addFile, setError } = useAppStore();
  const [dragging, setDragging] = useState(false);

  async function handlePaths(paths: string[]) {
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      try {
        const info = await getPdfInfo(path);
        const file: LoadedFile = { path, name, info };
        addFile(file);
      } catch {
        // Still add file even if info fetch fails
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

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const paths: string[] = [];
      for (const item of Array.from(e.dataTransfer.items)) {
        const file = item.getAsFile();
        if (file && (file as any).path) paths.push((file as any).path);
      }
      if (paths.length > 0) await handlePaths(paths);
    },
    []
  );

  return (
    <div
      onClick={handleBrowse}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`
        border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all
        ${dragging
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
          : "border-gray-300 dark:border-gray-600 hover:border-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
        }
      `}
    >
      <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p className="text-sm font-medium">
          {label ?? `Drop ${accept.join(", ")} files here or click to browse`}
        </p>
        <p className="text-xs text-gray-400">Your files never leave your device</p>
      </div>
    </div>
  );
}
