import { useEffect, useState } from "react";
import { getFormFields } from "../lib/tauri";
import type { FormField } from "../lib/tauri";

interface Props {
  pdfPath: string;
  pageNum: number; // 1-indexed
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
  isEnabled,
  onFieldChanged,
  filledFields,
}: Props) {
  const [fields, setFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    getFormFields(pdfPath)
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
      {fields.map((field, i) => {
        // Radio buttons share their group's name, so the name alone is not a key.
        const key = `${field.name}#${i}`;
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
                key={key}
                value={value}
                style={rectStyle}
                onChange={(e) => handleChange(field.name, e.target.value)}
              />
            );
          }
          return (
            <input
              key={key}
              type="text"
              value={value}
              style={rectStyle}
              onChange={(e) => handleChange(field.name, e.target.value)}
            />
          );
        }

        if (field.field_type === "Btn") {
          const isRadio = (field.flags & (1 << 15)) !== 0;
          // The value is the widget's on-state name ("Yes", "On", "Choice2"…).
          const onState = field.on_state ?? "Yes";
          return (
            <input
              key={key}
              type={isRadio ? "radio" : "checkbox"}
              checked={value !== "" && value === onState}
              style={{
                ...rectStyle,
                padding: 0,
                cursor: "pointer",
              }}
              onChange={(e) =>
                handleChange(field.name, e.target.checked ? onState : "Off")
              }
            />
          );
        }

        if (field.field_type === "Ch") {
          return (
            <select
              key={key}
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
