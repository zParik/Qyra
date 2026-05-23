import { create } from "zustand";
import { PdfInfo } from "../lib/tauri";

export interface LoadedFile {
  path: string;
  name: string;
  info?: PdfInfo;
  thumbnail?: string;
}

export interface TabEntry {
  path: string;
  name: string;
  type?: "home" | "pdf";
  info?: PdfInfo;
  thumbnail?: string;
}

export type Tool =
  | "merge" | "split" | "compress" | "rotate" | "remove"
  | "reorder" | "pdf-to-images" | "images-to-pdf"
  | "page-numbers" | "protect" | "unlock" | "metadata";

interface AppState {
  // Multi-file tools
  files: LoadedFile[];
  currentTool: Tool | null;
  result: string | null;
  resultFiles: string[];
  isProcessing: boolean;
  progress: { current: number; total: number; message: string } | null;
  error: string | null;
  cancelFn: (() => void) | null;

  // Multi-tab viewer
  openTabs: TabEntry[];
  activeTabIndex: number;

  // Per-path keyed state (path → value)
  tabFiles: Record<string, LoadedFile>;
  tabUndo: Record<string, LoadedFile | null>;
  tabOriginal: Record<string, string>;
  tabDirty: Record<string, boolean>;

  // Legacy shims — real state fields, synced on each tab action
  viewerFile: LoadedFile | null;
  undoViewerFile: LoadedFile | null;
  originalViewerPath: string | null;
  isViewerDirty: boolean;

  // Multi-file tool actions
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

  // Tab actions
  openTab: (entry: TabEntry) => void;
  closeTab: (index: number) => void;
  activateTab: (index: number) => void;
  reorderTab: (from: number, to: number) => void;
  replaceTab: (index: number, entry: TabEntry) => void;
  setTabFile: (path: string, file: LoadedFile) => void;
  setTabUndo: (path: string, file: LoadedFile | null) => void;
  setTabOriginal: (path: string, p: string) => void;
  setTabDirty: (path: string, v: boolean) => void;

  // Legacy shim setters
  setViewerFile: (file: LoadedFile | null) => void;
  setUndoViewerFile: (file: LoadedFile | null) => void;
  setOriginalViewerPath: (path: string | null) => void;
  setIsViewerDirty: (v: boolean) => void;
}

type SyncSlice = Pick<AppState,
  "openTabs" | "activeTabIndex" | "tabFiles" | "tabUndo" | "tabOriginal" | "tabDirty"
>;

function legacySync(s: SyncSlice) {
  const tab = s.activeTabIndex >= 0 ? s.openTabs[s.activeTabIndex] : undefined;
  return {
    viewerFile: tab ? (s.tabFiles[tab.path] ?? tab) : null,
    undoViewerFile: tab ? (s.tabUndo[tab.path] ?? null) : null,
    originalViewerPath: tab ? (s.tabOriginal[tab.path] ?? null) : null,
    isViewerDirty: tab ? (s.tabDirty[tab.path] ?? false) : false,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  files: [],
  currentTool: null,
  result: null,
  resultFiles: [],
  isProcessing: false,
  progress: null,
  error: null,
  cancelFn: null,

  openTabs: [],
  activeTabIndex: -1,
  tabFiles: {},
  tabUndo: {},
  tabOriginal: {},
  tabDirty: {},

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
      if (moved) files.splice(toIndex, 0, moved);
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

  openTab: (entry) =>
    set((s) => {
      if (!entry.path) return {};
      const existing = s.openTabs.findIndex((t) => t.path === entry.path);
      if (existing !== -1) {
        const next: SyncSlice = { ...s, activeTabIndex: existing };
        return { activeTabIndex: existing, ...legacySync(next) };
      }
      const newTabs = [...s.openTabs, entry];
      const next: SyncSlice = {
        openTabs: newTabs,
        activeTabIndex: newTabs.length - 1,
        tabFiles: { ...s.tabFiles, [entry.path]: entry },
        tabOriginal: { ...s.tabOriginal, [entry.path]: entry.path },
        tabUndo: s.tabUndo,
        tabDirty: s.tabDirty,
      };
      return { ...next, ...legacySync(next) };
    }),

  closeTab: (index) =>
    set((s) => {
      const tab = s.openTabs[index];
      const newTabs = s.openTabs.filter((_, i) => i !== index);
      let newActive = s.activeTabIndex;
      if (newActive >= newTabs.length) newActive = newTabs.length - 1;
      const tabFiles = { ...s.tabFiles };
      const tabUndo = { ...s.tabUndo };
      const tabOriginal = { ...s.tabOriginal };
      const tabDirty = { ...s.tabDirty };
      if (tab) {
        delete tabFiles[tab.path];
        delete tabUndo[tab.path];
        delete tabOriginal[tab.path];
        delete tabDirty[tab.path];
      }
      const next: SyncSlice = { openTabs: newTabs, activeTabIndex: newActive, tabFiles, tabUndo, tabOriginal, tabDirty };
      return { ...next, ...legacySync(next) };
    }),

  activateTab: (index) =>
    set((s) => {
      const next: SyncSlice = { ...s, activeTabIndex: index };
      return { activeTabIndex: index, ...legacySync(next) };
    }),

  reorderTab: (from, to) =>
    set((s) => {
      const tabs = [...s.openTabs];
      const [moved] = tabs.splice(from, 1);
      if (moved) tabs.splice(to, 0, moved);
      let newActive = s.activeTabIndex;
      if (s.activeTabIndex === from) newActive = to;
      else if (s.activeTabIndex > from && s.activeTabIndex <= to) newActive--;
      else if (s.activeTabIndex < from && s.activeTabIndex >= to) newActive++;
      const next: SyncSlice = { ...s, openTabs: tabs, activeTabIndex: newActive };
      return { openTabs: tabs, activeTabIndex: newActive, ...legacySync(next) };
    }),

  replaceTab: (index, entry) =>
    set((s) => {
      const oldTab = s.openTabs[index];
      const newTabs = [...s.openTabs];
      newTabs[index] = entry;
      const tabFiles = { ...s.tabFiles, [entry.path]: entry };
      const tabOriginal = { ...s.tabOriginal, [entry.path]: entry.path };
      const tabUndo = { ...s.tabUndo };
      const tabDirty = { ...s.tabDirty };
      if (oldTab && oldTab.path !== entry.path) {
        delete tabFiles[oldTab.path];
        delete tabOriginal[oldTab.path];
        delete tabUndo[oldTab.path];
        delete tabDirty[oldTab.path];
      }
      const next: SyncSlice = { openTabs: newTabs, activeTabIndex: s.activeTabIndex, tabFiles, tabUndo, tabOriginal, tabDirty };
      return { ...next, ...legacySync(next) };
    }),

  setTabFile: (path, file) =>
    set((s) => {
      const tabFiles = { ...s.tabFiles, [path]: file };
      const next: SyncSlice = { ...s, tabFiles };
      return { tabFiles, ...legacySync(next) };
    }),
  setTabUndo: (path, file) =>
    set((s) => {
      const tabUndo = { ...s.tabUndo, [path]: file };
      const next: SyncSlice = { ...s, tabUndo };
      return { tabUndo, ...legacySync(next) };
    }),
  setTabOriginal: (path, p) =>
    set((s) => {
      const tabOriginal = { ...s.tabOriginal, [path]: p };
      const next: SyncSlice = { ...s, tabOriginal };
      return { tabOriginal, ...legacySync(next) };
    }),
  setTabDirty: (path, v) =>
    set((s) => {
      const tabDirty = { ...s.tabDirty, [path]: v };
      const next: SyncSlice = { ...s, tabDirty };
      return { tabDirty, ...legacySync(next) };
    }),

  setViewerFile: (file) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab || !file) return;
    set((st) => {
      const tabFiles = { ...st.tabFiles, [tab.path]: file };
      return { tabFiles, viewerFile: file };
    });
  },
  setUndoViewerFile: (file) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab) return;
    set((st) => ({ tabUndo: { ...st.tabUndo, [tab.path]: file }, undoViewerFile: file }));
  },
  setOriginalViewerPath: (p) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab || !p) return;
    set((st) => ({ tabOriginal: { ...st.tabOriginal, [tab.path]: p }, originalViewerPath: p }));
  },
  setIsViewerDirty: (v) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab) return;
    set((st) => ({ tabDirty: { ...st.tabDirty, [tab.path]: v }, isViewerDirty: v }));
  },
}));
