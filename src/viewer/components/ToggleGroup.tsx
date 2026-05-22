import type { ReactNode } from "react";

interface ToggleOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface ToggleGroupProps<T extends string> {
  options: ToggleOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** Optional extra class on each button. */
  buttonClassName?: string;
}

/**
 * Horizontal toggle button row using existing `v-toggle-on` / `v-toggle-off`
 * utility classes. Used by RotatePanel, ExportImagesPanel, PageNumbersPanel.
 */
export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  buttonClassName = "",
}: ToggleGroupProps<T>) {
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${
            value === opt.value ? "v-toggle-on" : "v-toggle-off"
          } ${buttonClassName}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
