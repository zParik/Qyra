import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FormFieldValue {
  name: string;
  value: string;
}

interface UseFormFillingReturn {
  isFormMode: boolean;
  setIsFormMode: (v: boolean) => void;
  fieldValues: Record<string, string>;
  setFieldValue: (name: string, value: string) => void;
  saveFormFields: (filePath: string) => Promise<string | null>;
  isDirty: boolean;
  clearFields: () => void;
}

export function useFormFilling(): UseFormFillingReturn {
  const [isFormMode, setIsFormMode] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [isDirty, setIsDirty] = useState(false);

  const setFieldValue = useCallback((name: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
    setIsDirty(true);
  }, []);

  const saveFormFields = useCallback(
    async (filePath: string): Promise<string | null> => {
      const fields: FormFieldValue[] = Object.entries(fieldValues).map(
        ([name, value]) => ({ name, value })
      );
      if (fields.length === 0) return null;
      try {
        const result = await invoke<string>("fill_form", {
          path: filePath,
          fields,
          flatten: false,
        });
        setIsDirty(false);
        return result;
      } catch {
        return null;
      }
    },
    [fieldValues]
  );

  const clearFields = useCallback(() => {
    setFieldValues({});
    setIsDirty(false);
  }, []);

  return {
    isFormMode,
    setIsFormMode,
    fieldValues,
    setFieldValue,
    saveFormFields,
    isDirty,
    clearFields,
  };
}
