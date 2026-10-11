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

/** App-wide tile cache: 256 MB of canvas backing. */
export const tileCache = new TileCache(256 * 1024 * 1024);
