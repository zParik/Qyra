// LRU of rendered tile canvases, bounded by backing-store bytes (w*h*4).
// The canvas element itself is cached so a remounted page re-attaches it with
// no re-render and no second copy of the pixels.
export const tileKeyPrefix = (path: string) => `${path}\u0000`;

export function tileKey(path: string, version: string, page: number, scale: number, tx: number, ty: number): string {
  return `${tileKeyPrefix(path)}${version}|${page}|${scale}|${tx}|${ty}`;
}

const cost = (c: HTMLCanvasElement) => c.width * c.height * 4;

export class TileCache {
  private map = new Map<string, HTMLCanvasElement>();
  private total = 0;

  constructor(private budget: number) {}

  get bytes(): number {
    return this.total;
  }

  get(key: string): HTMLCanvasElement | undefined {
    const c = this.map.get(key);
    if (c) {
      this.map.delete(key);
      this.map.set(key, c);
    }
    return c;
  }

  put(key: string, canvas: HTMLCanvasElement): void {
    const old = this.map.get(key);
    if (old) this.remove(key, old);
    this.map.set(key, canvas);
    this.total += cost(canvas);
    // Evict least-recent first, but never a canvas that is on screen (attached):
    // freeing it would blank visible content in favour of prefetch.
    for (const [k, c] of Array.from(this.map)) {
      if (this.total <= this.budget) break;
      if (k === key || c.isConnected) continue;
      this.remove(k, c);
    }
  }

  dropPrefix(prefix: string): void {
    for (const [k, c] of Array.from(this.map)) if (k.startsWith(prefix)) this.remove(k, c);
  }

  private remove(key: string, c: HTMLCanvasElement): void {
    this.map.delete(key);
    this.total -= cost(c);
    c.remove();
    c.width = 0;
    c.height = 0;
  }
}

const MB = 1024 * 1024;

/**
 * Canvas bytes to keep: about three screens of device pixels (what is on screen
 * plus the prefetch band, with room to scroll back), within 48–192 MB.
 */
export function tileBudget(screenW: number, screenH: number, dpr: number): number {
  const screen = screenW * dpr * screenH * dpr * 4;
  return Math.min(192 * MB, Math.max(48 * MB, screen * 3));
}

/** App-wide tile cache, sized to the screen the app starts on. */
export const tileCache = new TileCache(
  tileBudget(window.screen.width, window.screen.height, window.devicePixelRatio || 1),
);
