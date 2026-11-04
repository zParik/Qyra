import { useState, useCallback } from "react";

/**
 * Form values typed into the viewer's form layer, keyed by full field name.
 * They are written into the file by the viewer's save (fill_form), then
 * cleared.
 */
export function useFormFilling() {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const setFieldValue = useCallback((name: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  /** Forget the given values (once saved), keeping any changed since. */
  const dropFields = useCallback((saved: Record<string, string>) => {
    setFieldValues((prev) => {
      const next = { ...prev };
      for (const [name, value] of Object.entries(saved)) {
        if (next[name] === value) delete next[name];
      }
      return next;
    });
  }, []);

  return { fieldValues, setFieldValue, dropFields };
}
