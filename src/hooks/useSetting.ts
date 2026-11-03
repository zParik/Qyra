import { useCallback, useEffect, useState } from "react";
import { SettingSpec, loadSetting, storeSetting } from "../lib/settings";

/**
 * Read/write a single persisted setting. Loads from SQLite on mount (falling
 * back to the registered default) and persists each user change from the
 * setter, so the loaded value is never written back and no change is skipped.
 * Returns [value, setValue, loaded].
 */
export function useSetting<T>(spec: SettingSpec<T>): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(spec.default);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    loadSetting(spec).then((v) => {
      if (!alive) return;
      setValue(v);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // spec is a stable module-level object; key identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.key]);

  const set = useCallback((v: T) => {
    setValue(v);
    storeSetting(spec, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.key]);

  return [value, set, loaded];
}
