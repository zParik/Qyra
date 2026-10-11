// Per-path "the file was rewritten" counter. Bumped whenever Qyra writes over a
// document (save, bake, edit-in-place), so every render of it — viewer tiles,
// page info, <img> thumbnails anywhere in the app — knows to refetch.
import { useSyncExternalStore } from "react";

const versions = new Map<string, number>();
const listeners = new Set<() => void>();

export function getDocVersion(path: string): number {
  return versions.get(path) ?? 0;
}

export function bumpDocVersion(path: string): void {
  versions.set(path, getDocVersion(path) + 1);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Current rewrite counter for `path`; re-renders the caller when it is bumped. */
export function useDocVersion(path: string): number {
  return useSyncExternalStore(subscribe, () => getDocVersion(path));
}
