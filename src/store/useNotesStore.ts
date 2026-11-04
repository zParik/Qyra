import { create } from "zustand";

export type Point = [x: number, y: number, pressure: number];
export type PageTemplate = 'blank' | 'ruled' | 'grid' | 'dotted';

export interface Stroke {
  id: string;
  pageSlotId: string; // stable: 'pdf-1', 'pdf-2', ... or virtual page UUID
  tool: 'pen' | 'highlighter' | 'calligraphy' | 'bezier' | 'eraser';
  color: string;
  baseThickness: number;
  points: Point[];
}

export interface VirtualPage {
  id: string;
  template: PageTemplate;
  afterRealPage: number; // 0 = before all PDF pages, 1 = after PDF page 1, etc.
}

interface NotesState {
  strokes: Record<string, Stroke[]>; // keyed by the tab's path (see Viewer)
  addStroke: (docPath: string, stroke: Stroke) => void;
  undoStroke: (docPath: string) => void;
  removeStroke: (docPath: string, strokeId: string) => void;
  replaceStroke: (docPath: string, strokeId: string, replacements: Stroke[]) => void;
  clearStrokes: (docPath: string) => void;

  virtualPages: Record<string, VirtualPage[]>; // keyed by docPath
  addVirtualPage: (docPath: string, vp: VirtualPage) => void;
  removeVirtualPage: (docPath: string, vpId: string) => void;

  // Active drawing settings
  drawColor: string;
  drawThickness: number;
  drawTool: 'pen' | 'highlighter' | 'calligraphy' | 'bezier' | 'eraser';
  drawNibAngle: number; // degrees, for calligraphy (0 = horizontal nib)
  eraserSize: number;   // screen-pixel radius of the eraser circle
  setDrawColor: (color: string) => void;
  setDrawThickness: (thickness: number) => void;
  setDrawTool: (tool: 'pen' | 'highlighter' | 'calligraphy' | 'bezier' | 'eraser') => void;
  setDrawNibAngle: (angle: number) => void;
  setEraserSize: (size: number) => void;
}

export const useNotesStore = create<NotesState>((set) => ({
  strokes: {},
  addStroke: (docPath, stroke) =>
    set((state) => ({
      strokes: {
        ...state.strokes,
        [docPath]: [...(state.strokes[docPath] || []), stroke],
      }
    })),
  undoStroke: (docPath) =>
    set((state) => {
      const existing = state.strokes[docPath];
      if (!existing || existing.length === 0) return state;
      return { strokes: { ...state.strokes, [docPath]: existing.slice(0, -1) } };
    }),
  removeStroke: (docPath, strokeId) =>
    set((state) => ({
      strokes: {
        ...state.strokes,
        [docPath]: (state.strokes[docPath] || []).filter(s => s.id !== strokeId),
      }
    })),
  replaceStroke: (docPath, strokeId, replacements) =>
    set((state) => {
      const existing = state.strokes[docPath] || [];
      const idx = existing.findIndex(s => s.id === strokeId);
      if (idx === -1) return state;
      const next = [...existing];
      next.splice(idx, 1, ...replacements);
      return { strokes: { ...state.strokes, [docPath]: next } };
    }),
  clearStrokes: (docPath) =>
    set((state) => {
      const newStrokes = { ...state.strokes };
      delete newStrokes[docPath];
      return { strokes: newStrokes };
    }),

  virtualPages: {},
  addVirtualPage: (docPath, vp) =>
    set((state) => ({
      virtualPages: {
        ...state.virtualPages,
        [docPath]: [...(state.virtualPages[docPath] || []), vp],
      }
    })),
  removeVirtualPage: (docPath, vpId) =>
    set((state) => ({
      virtualPages: {
        ...state.virtualPages,
        [docPath]: (state.virtualPages[docPath] || []).filter(v => v.id !== vpId),
      }
    })),

  drawColor: '#1d4ed8',
  drawThickness: 4,
  drawTool: 'pen',
  drawNibAngle: 45,
  eraserSize: 20,
  setDrawColor: (color) => set({ drawColor: color }),
  setDrawThickness: (thickness) => set({ drawThickness: thickness }),
  setDrawTool: (tool) => set({ drawTool: tool }),
  setDrawNibAngle: (angle) => set({ drawNibAngle: angle }),
  setEraserSize: (size) => set({ eraserSize: size }),
}));
