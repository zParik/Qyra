import type { InputHTMLAttributes, ReactNode } from "react";

interface LabeledInputProps {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: ReactNode;
  inputClassName?: string;
  /** Pass-through HTML input attrs (min, max, onKeyDown, etc.) */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "placeholder" | "className">;
}

/**
 * label + input + optional hint paragraph.
 * Uses the existing `v-input` class so all panels stay visually consistent.
 */
export function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  inputClassName = "v-input",
  inputProps,
}: LabeledInputProps) {
  return (
    <div>
      <label className="text-xs mb-1 block" style={{ color: "var(--viewer-text-muted)" }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClassName}
        {...inputProps}
      />
      {hint && (
        <p className="text-xs mt-1" style={{ color: "var(--viewer-text-muted)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
