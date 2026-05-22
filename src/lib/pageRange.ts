/** Parse a page range string like "1, 3-5, 7" into a sorted, deduplicated list of 1-indexed page numbers. Silently drops invalid or out-of-range parts. */
export function parsePages(input: string, maxPage: number): number[] {
  const pages = new Set<number>();
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (a !== undefined && b !== undefined && !isNaN(a) && !isNaN(b) && a >= 1 && b >= a && b <= maxPage) {
        for (let i = a; i <= b; i++) pages.add(i);
      }
    } else {
      const n = Number(part);
      if (!isNaN(n) && n >= 1 && n <= maxPage) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Format a list of 1-indexed page numbers into a compact range string like "1, 3-5, 7". */
export function formatPages(pages: number[]): string {
  if (pages.length === 0) return "";
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur === end + 1) {
      end = cur;
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = cur;
      end = cur;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}
