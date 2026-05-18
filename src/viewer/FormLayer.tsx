import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FormField {
  name: string;
  field_type: string; // "Tx" | "Btn" | "Ch" | "Sig"
  value: string;
  page: number;
  rect: [number, number, number, number]; // [x0, y0, x1, y1] normalized [0,1]
  options: string[];
  flags: number;
}

interface Props {
  pdfPath: string;
  pageNum: number; // 1-indexed
  zoom: number;
  isEnabled: boolean;
  onFieldChanged?: (name: string, value: string) => void;
  filledFields?: Record<string, string>;
}

const baseInputStyle: React.CSSProperties = {
  position: "absolute",
  background: "rgba(255, 235, 59, 0.15)",
  border: "1px solid rgba(255, 193, 7, 0.4)",
  borderRadius: 2,
  padding: "0 2px",
  fontSize: "inherit",
  fontFamily: "inherit",
  outline: "none",
  resize: "none" as const,
  overflow: "hidden",
  boxSizing: "border-box",
};

export function FormLayer({
  pdfPath,
  pageNum,
  zoom: _zoom,
  isEnabled,
  onFieldChanged,
  filledFields,
}: Props) {
  const [fields, setFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    invoke<FormField[]>("get_form_fields", { path: pdfPath })
      .then((data) => {
        if (cancelled) return;
        const pageFields = data.filter((f) => f.page === pageNum);
        setFields(pageFields);
        const initial: Record<string, string> = {};
        for (const f of pageFields) {
          initial[f.name] = f.value ?? "";
        }
        setValues(initial);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPath, pageNum]);

  // Merge parent-injected values over local state
  const effectiveValues = filledFields
    ? { ...values, ...filledFields }
    : values;

  function handleChange(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    onFieldChanged?.(name, value);
  }

  if (!isEnabled || fields.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 15,
      }}
    >
      {fields.map((field) => {
        const [x0, y0, x1, y1] = field.rect;
        const w = x1 - x0;
        const h = y1 - y0;
        if (w <= 0 || h <= 0) return null;

        const rectStyle: React.CSSProperties = {
          ...baseInputStyle,
          left: `${x0 * 100}%`,
          top: `${y0 * 100}%`,
          width: `${w * 100}%`,
          height: `${h * 100}%`,
          pointerEvents: "auto",
        };

        const value = effectiveValues[field.name] ?? "";

        if (field.field_type === "Tx") {
          const isMultiline = (field.flags & (1 << 12)) !== 0;
          if (isMultiline) {
            return (
              <textarea
                key={field.name}
                value={value}
                style={rectStyle}
                onChange={(e) => handleChange(field.name, e.target.value)}
              />
            );
          }
          return (
            <input
              key={field.name}
              type="text"
              value={value}
              style={rectStyle}
              onChange={(e) => handleChange(field.name, e.target.value)}
            />
          );
        }

        if (field.field_type === "Btn") {
          const isRadio = (field.flags & (1 << 15)) !== 0;
          return (
            <input
              key={field.name}
              type={isRadio ? "radio" : "checkbox"}
              checked={value === "Yes" || value === "On" || value === "true"}
              style={{
                ...rectStyle,
                padding: 0,
                cursor: "pointer",
              }}
              onChange={(e) =>
                handleChange(field.name, e.target.checked ? "Yes" : "Off")
              }
            />
          );
        }

        if (field.field_type === "Ch") {
          return (
            <select
              key={field.name}
              value={value}
              style={rectStyle}
              onChange={(e) => handleChange(field.name, e.target.value)}
            >
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          );
        }

        return null;
      })}
    </div>
  );
}
