// Page sizes + version for `path`, refetched whenever the file is rewritten.
// Returns null until the info for THIS path has arrived, so a caller never sees
// a previous document's sizes under a new path.
import { useEffect, useState } from "react";
import { docOpen, type DocInfo } from "./renderClient";
import { useDocVersion } from "./docVersion";

export function useDocInfo(path: string | null | undefined): DocInfo | null {
  const gen = useDocVersion(path ?? "");
  const [loaded, setLoaded] = useState<{ path: string; info: DocInfo } | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    docOpen(path)
      .then((info) => { if (!cancelled) setLoaded({ path, info }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, gen]);

  return loaded && loaded.path === path ? loaded.info : null;
}
