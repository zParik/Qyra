/**
 * Session Cache — disk-backed per-session cache via Tauri IPC.
 *
 * Stores rendered thumbnails (and any other transient data) on disk in a
 * per-PID temp directory managed by the Rust backend.  Data survives page
 * reloads during development but is cleaned up when the app process exits.
 *
 * Usage:
 *   import { sessionCache } from "../lib/sessionCache";
 *   await sessionCache.put("thumb:myfile.pdf:3:2.0", dataUrl);
 *   const cached = await sessionCache.get("thumb:myfile.pdf:3:2.0");
 */

import { invoke } from "@tauri-apps/api/core";

export interface CacheStats {
  root: string;
  entry_count: number;
  total_bytes: number;
}

/**
 * Thin async wrapper around the Rust session-cache commands.
 * Methods never throw — failures are silently swallowed so callers
 * can treat the cache as best-effort without try/catch boilerplate.
 */
export const sessionCache = {
  /** Store a string value under `key`. */
  async put(key: string, value: string): Promise<void> {
    try {
      await invoke("cache_put", { key, value });
    } catch {
      /* cache miss is fine */
    }
  },

  /** Retrieve a cached value, or `null` if absent. */
  async get(key: string): Promise<string | null> {
    try {
      return await invoke<string | null>("cache_get", { key });
    } catch {
      return null;
    }
  },

  /** Check if a key exists (cheaper than reading the value). */
  async has(key: string): Promise<boolean> {
    try {
      return await invoke<boolean>("cache_has", { key });
    } catch {
      return false;
    }
  },

  /** Remove a single key. */
  async remove(key: string): Promise<void> {
    try {
      await invoke("cache_remove", { key });
    } catch {
      /* ignore */
    }
  },

  /** Remove all keys that start with `prefix`. Returns the count of evicted entries. */
  async evictPrefix(prefix: string): Promise<number> {
    try {
      return await invoke<number>("cache_evict_prefix", { prefix });
    } catch {
      return 0;
    }
  },

  /** Get cache statistics (root dir, entry count, total bytes). */
  async stats(): Promise<CacheStats | null> {
    try {
      return await invoke<CacheStats>("cache_stats");
    } catch {
      return null;
    }
  },

  /** Wipe the entire session cache. */
  async clear(): Promise<void> {
    try {
      await invoke("cache_clear");
    } catch {
      /* ignore */
    }
  },
};

// ─── Thumbnail-specific helpers ──────────────────────────────────────────────

/** Build a cache key for a rendered page thumbnail. */
export function thumbKey(path: string, page: number, scale: number): string {
  return `thumb:${path}:${page}:${scale}`;
}

/** Build the key prefix for evicting all thumbnails of a given file. */
export function thumbPrefix(path: string): string {
  return `thumb:${path}:`;
}

// ─── Persistent thumbnail store (survives restarts) ──────────────────────────

/** Fetch a thumbnail from the persistent on-disk store. Returns null on miss. */
export async function thumbStoreGet(path: string, page: number, scale: number): Promise<string | null> {
  try {
    return await invoke<string | null>("thumb_get", { path, page, scale });
  } catch {
    return null;
  }
}

/** Write a thumbnail to the persistent on-disk store (fire-and-forget safe). */
export async function thumbStorePut(path: string, page: number, scale: number, data: string): Promise<void> {
  try {
    await invoke("thumb_put", { path, page, scale, data });
  } catch {
    /* non-critical */
  }
}

/** Evict all persistent thumbnails for a given file path. */
export async function thumbStoreEvict(path: string): Promise<void> {
  try {
    await invoke("thumb_evict", { path });
  } catch {
    /* non-critical */
  }
}
