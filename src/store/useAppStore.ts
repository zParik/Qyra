import { create } from "zustand";
import { PdfInfo } from "../lib/tauri";

export interface LoadedFile {
  path: string;
  name: string;
  info?: PdfInfo;
  thumbnail?: string; // base64 data URL for page 1
}

export type Tool =
  | "merge" | "split" | "compress" | "rotate" | "remove"
  | "reorder" | "pdf-to-images" | "images-to-pdf"
  | "page-numbers" | "protect" | "unlock" | "metadata";

interface AppState {
  // Multi-file tools (Merge, ImagesToPdf)
  files: LoadedFile[];
  currentTool: Tool | null;
  result: string | null;
  resultFiles: string[];
  isProcessing: boolean;
  progress: { current: number; total: number; message: string } | null;
  error: string | null;
  cancelFn: (() => void) | null;

  // Viewer: single open file
  viewerFile: LoadedFile | null;
  undoViewerFile: LoadedFile | null; // snapshot before last panel operation
  originalViewerPath: string | null;
  isViewerDirty: boolean;

  setCancelFn: (fn: (() => void) | null) => void;
  setFiles: (files: LoadedFile[]) => void;
  addFile: (file: LoadedFile) => void;
  removeFile: (path: string) => void;
  reorderFiles: (fromIndex: number, toIndex: number) => void;
  clearFiles: () => void;
  setCurrentTool: (tool: Tool | null) => void;
  setResult: (result: string | null) => void;
  setResultFiles: (files: string[]) => void;
  setIsProcessing: (v: boolean) => void;
  setProgress: (p: { current: number; total: number; message: string } | null) => void;
  setError: (e: string | null) => void;
  reset: () => void;
  setViewerFile: (file: LoadedFile | null) => void;
  setUndoViewerFile: (file: LoadedFile | null) => void;
  setOriginalViewerPath: (path: string | null) => void;
  setIsViewerDirty: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  files: [],
  currentTool: null,
  result: null,
  resultFiles: [],
  isProcessing: false,
  progress: null,
  error: null,
  cancelFn: null,
  viewerFile: null,
  undoViewerFile: null,
  originalViewerPath: null,
  isViewerDirty: false,

  setCancelFn: (cancelFn) => set({ cancelFn }),
  setFiles: (files) => set({ files }),
  addFile: (file) => set((s) => ({ files: [...s.files, file] })),
  removeFile: (path) => set((s) => ({ files: s.files.filter((f) => f.path !== path) })),
  reorderFiles: (fromIndex, toIndex) =>
    set((s) => {
      const files = [...s.files];
      const [moved] = files.splice(fromIndex, 1);
      files.splice(toIndex, 0, moved);
      return { files };
    }),
  clearFiles: () => set({ files: [] }),
  setCurrentTool: (tool) => set({ currentTool: tool, result: null, resultFiles: [], error: null }),
  setResult: (result) => set({ result }),
  setResultFiles: (resultFiles) => set({ resultFiles }),
  setIsProcessing: (isProcessing) => set({ isProcessing }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  reset: () => set({ result: null, resultFiles: [], error: null, isProcessing: false, progress: null, cancelFn: null }),
  setViewerFile: (viewerFile) => set({ viewerFile }),
  setUndoViewerFile: (undoViewerFile) => set({ undoViewerFile }),
  setOriginalViewerPath: (originalViewerPath) => set({ originalViewerPath }),
  setIsViewerDirty: (isViewerDirty) => set({ isViewerDirty }),
}));
