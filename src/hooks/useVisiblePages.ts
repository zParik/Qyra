import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Tracks which page-slot elements are visible (or nearly visible) inside a
 * scroll container, using an IntersectionObserver.
 *
 * Consumers register / un-register elements via the returned `observe` and
 * `unobserve` helpers (typically via a ref-callback on each page wrapper).
 *
 * Returns a Set<string> of visible slot IDs.  The observer uses a generous
 * root-margin so pages just outside the viewport are pre-loaded.
 */
export function useVisiblePages(
  scrollRoot: React.RefObject<HTMLElement | null>,
  /** How many pixels above & below the viewport to pre-load */
  bufferPx = 800,
) {
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Keep a stable map so we can look up slotId from element
  const elToIdRef = useRef<Map<Element, string>>(new Map());

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleIds((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const id = elToIdRef.current.get(entry.target);
            if (!id) continue;
            if (entry.isIntersecting && !prev.has(id)) {
              next.add(id);
              changed = true;
            } else if (!entry.isIntersecting && prev.has(id)) {
              next.delete(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      {
        root,
        rootMargin: `${bufferPx}px 0px ${bufferPx}px 0px`,
        threshold: 0,
      },
    );

    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [scrollRoot, bufferPx]);

  const observe = useCallback((el: Element | null, slotId: string) => {
    if (!el || !observerRef.current) return;
    elToIdRef.current.set(el, slotId);
    observerRef.current.observe(el);
  }, []);

  const unobserve = useCallback((el: Element | null) => {
    if (!el || !observerRef.current) return;
    observerRef.current.unobserve(el);
    elToIdRef.current.delete(el);
  }, []);

  return { visibleIds, observe, unobserve };
}
