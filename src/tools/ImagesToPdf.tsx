import { useCallback, useEffect } from "react";
import { ToolLayout } from "../components/ToolLayout";
import { useAppStore, LoadedFile } from "../store/useAppStore";
import { usePdfCommand } from "../hooks/usePdfCommand";
import { imagesToPdf } from "../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import { isAndroid, pickFilesAndroid } from "../lib/androidFileUtils";

export default function ImagesToPdf() {
  const { files, addFile, removeFile, clearFiles, isProcessing, reset } = useAppStore();

  useEffect(() => {
    clearFiles();
    reset();
  }, []);
  const { run } = usePdfCommand();

  const handleBrowse = useCallback(async () => {
    if (isAndroid()) {
      const picked = await pickFilesAndroid("image/png,image/jpeg,image/webp", true);
      for (const { path, name } of picked) {
        addFile({ path, name } as LoadedFile);
      }
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
    <ToolLayout title="Images to PDF" description="Combine PNG, JPG, or WebP images into a PDF">
      <div
        onClick={handleBrowse}
        className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-all"
      >
        <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
          <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-sm font-medium">Drop images here or click to browse</p>
          <p className="text-xs text-gray-400">PNG, JPG, WebP supported</p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">{files.length} image{files.length !== 1 ? "s" : ""} selected</p>
            <button onClick={clearFiles} className="text-xs text-gray-400 hover:text-red-500">Clear all</button>
          </div>

          <div className="space-y-1.5">
            {files.map((file, i) => (
              <div key={file.path} className="flex items-center gap-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2">
                <span className="text-xs text-gray-400 w-5 text-right flex-shrink-0">{i + 1}</span>
                <p className="text-sm flex-1 truncate">{file.name}</p>
                <button
                  onClick={() => removeFile(file.path)}
                  className="text-gray-400 hover:text-red-500"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <button
            disabled={isProcessing}
            onClick={handleConvert}
            className="btn-primary w-full"
          >
            Create PDF from {files.length} Image{files.length !== 1 ? "s" : ""}
          </button>
        </div>
      )}
    </ToolLayout>
  );
}
