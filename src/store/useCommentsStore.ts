import { create } from "zustand";
import type { Comment } from "../lib/schemas";

export type { Comment };

export const COMMENT_COLORS = [
  "#f59e0b", // amber (default)
  "#3b82f6", // blue
  "#22c55e", // green
  "#ef4444", // red
  "#a855f7", // purple
];

interface CommentsState {
  // keyed by docPath → list of comments
  comments: Record<string, Comment[]>;

  loadComments: (docPath: string, comments: Comment[]) => void;
  addComment: (docPath: string, comment: Comment) => void;
  updateComment: (docPath: string, id: string, updates: Partial<Pick<Comment, "text" | "color" | "resolved">>) => void;
  removeComment: (docPath: string, id: string) => void;
  clearComments: (docPath: string) => void;
}

export const useCommentsStore = create<CommentsState>((set) => ({
  comments: {},

  loadComments: (docPath, comments) =>
    set((state) => ({
      comments: { ...state.comments, [docPath]: comments },
    })),

  addComment: (docPath, comment) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [docPath]: [...(state.comments[docPath] ?? []), comment],
      },
    })),

  updateComment: (docPath, id, updates) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [docPath]: (state.comments[docPath] ?? []).map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      },
    })),

  removeComment: (docPath, id) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [docPath]: (state.comments[docPath] ?? []).filter((c) => c.id !== id),
      },
    })),

  clearComments: (docPath) =>
    set((state) => {
      const next = { ...state.comments };
      delete next[docPath];
      return { comments: next };
    }),
}));
