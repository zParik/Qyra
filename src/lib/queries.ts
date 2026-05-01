import { QueryClient, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getPdfInfo, getMetadata, setMetadata,
  getStarred, getArchived, setStarred, setArchived,
  loadComments, saveComments,
  getDiskSpace,
} from "./tauri";
import type { PdfMetadata } from "./schemas";
import { CommentSchema } from "./schemas";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// ─── PDF Info ────────────────────────────────────────────────────────────────

export function usePdfInfo(path: string | null) {
  return useQuery({
    queryKey: ["pdfInfo", path],
    queryFn: () => getPdfInfo(path!),
    enabled: !!path,
    staleTime: Infinity,
  });
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export function usePdfMetadata(path: string | null) {
  return useQuery({
    queryKey: ["pdfMetadata", path],
    queryFn: () => getMetadata(path!),
    enabled: !!path,
    staleTime: Infinity,
  });
}

export function useSetMetadata() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, metadata, output }: { path: string; metadata: PdfMetadata; output?: string }) =>
      setMetadata(path, metadata, output),
    onSuccess: (_, { path }) => {
      qc.invalidateQueries({ queryKey: ["pdfMetadata", path] });
      qc.invalidateQueries({ queryKey: ["pdfInfo", path] });
    },
  });
}

// ─── Library (starred / archived) ────────────────────────────────────────────

export function useStarred() {
  return useQuery({
    queryKey: ["starred"],
    queryFn: getStarred,
    staleTime: 5_000,
  });
}

export function useArchived() {
  return useQuery({
    queryKey: ["archived"],
    queryFn: getArchived,
    staleTime: 5_000,
  });
}

export function useSetStarred() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, name, starred }: { path: string; name: string; starred: boolean }) =>
      setStarred(path, name, starred),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["starred"] });
    },
  });
}

export function useSetArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, name, archived }: { path: string; name: string; archived: boolean }) =>
      setArchived(path, name, archived),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["archived"] });
    },
  });
}

// ─── Disk Space ───────────────────────────────────────────────────────────────

export function useDiskSpace() {
  return useQuery({
    queryKey: ["diskSpace"],
    queryFn: getDiskSpace,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

// ─── Comments ────────────────────────────────────────────────────────────────

export function usePdfComments(path: string | null) {
  return useQuery({
    queryKey: ["comments", path],
    queryFn: async () => {
      const json = await loadComments(path!);
      try {
        return CommentSchema.array().parse(JSON.parse(json));
      } catch {
        return [];
      }
    },
    enabled: !!path,
    staleTime: Infinity,
  });
}

export function useSaveComments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, commentsJson }: { path: string; commentsJson: string }) =>
      saveComments(path, commentsJson),
    onSuccess: (_, { path }) => {
      qc.invalidateQueries({ queryKey: ["comments", path] });
    },
  });
}
