import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but which always calls the latest
 * `fn`. Lets a memoized child keep its props equal across parent re-renders.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
