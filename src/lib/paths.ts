/** Split a path into its file name and directory. Handles both separators. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/**
 * Shorten a string in the middle, keeping its start and end, so a path keeps
 * both its root and its leaf. No bidi tricks: the text order stays as written.
 */
export function shortenMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.4);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
