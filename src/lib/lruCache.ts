/**
 * Minimal least-recently-used cache over a Map. Insertion order is recency
 * order; `get` and `set` move a key to the most-recent end, and inserting past
 * the capacity evicts the oldest entry. Used to bound the in-memory rendered-page
 * cache so browsing/zooming a large document can't grow the WebView heap without
 * limit. `has` deliberately does NOT refresh recency (it's a cheap existence
 * probe, not an access).
 */
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(private readonly cap: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Refresh recency: delete + re-insert moves the key to the newest end.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  get size(): number {
    return this.map.size;
  }
}
