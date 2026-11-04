function withSuffix(path: string, suffix: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = path.lastIndexOf(".");
  if (idx <= path.lastIndexOf(sep)) return `${path}_${suffix}.pdf`;
  return `${path.slice(0, idx)}_${suffix}${path.slice(idx)}`;
}

function joinPath(dir: string, name: string, suffix: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  const stem = name.replace(/\.pdf$/i, "");
  return `${trimmed}${sep}${stem}_${suffix}.pdf`;
}

/**
 * Output path for each input. Two inputs with the same file name from
 * different folders got the same path in the output folder, so the second
 * overwrote the first; later ones now get " (2)", " (3)"….
 */
export function batchOutputs(paths: string[], suffix: string, destDir: string | null): string[] {
  const seen = new Map<string, number>();
  return paths.map((path) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    const base = destDir ? joinPath(destDir, name, suffix) : withSuffix(path, suffix);
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? base : base.replace(/\.pdf$/i, ` (${n}).pdf`);
  });
}
