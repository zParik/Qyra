import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface FileMeasure { pages: number; bytes: number }

/**
 * Page count and size for a library entry. Every sheet carries its measure.
 * Uses the existing get_page_count / get_file_size commands; a missing file
 * simply yields no measure.
 */
export function useFileMeasure(path: string) {
  return useQuery<FileMeasure | null>({
    queryKey: ["measure", path],
    enabled: !!path,
    staleTime: Infinity,
    retry: 0,
    queryFn: async () => {
      const [pages, bytes] = await Promise.all([
        invoke<number>("get_page_count", { path }),
        invoke<number>("get_file_size", { path }),
      ]);
      if (typeof pages !== "number" || typeof bytes !== "number") return null;
      return { pages, bytes };
    },
  });
}
