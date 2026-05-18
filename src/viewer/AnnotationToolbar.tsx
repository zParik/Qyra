import React from "react";

const ANNOTATION_COLORS = [
  { label: "Yellow",  value: "#ffeb3b" },
  { label: "Red",     value: "#f44336" },
  { label: "Blue",    value: "#2196f3" },
  { label: "Green",   value: "#4caf50" },
  { label: "Purple",  value: "#9c27b0" },
];

export type AnnotationTool =
  | "highlight" | "underline" | "strikethrough" | "note"
  | "rect" | "circle" | "text";

export interface AnnotationToolbarProps {
  activeTool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool | null) => void;
  onExit: () => void;
  activeColor: string;
  onColorChange: (color: string) => void;
  currentPage: number;
  pageCount: number;
}

function Divider() {
  return (
    <div
      className="shrink-0 self-stretch mx-1"
      style={{ width: "1px", background: "var(--viewer-border)" }}
    />
  );
}

const TOOLS: { id: AnnotationTool; label: string; icon: React.ReactNode }[] = [
  {
    id: "highlight",
    label: "Highlight",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15.232 5.232l3.536 3.536M9 13l-4 4 1 3 3-1 4-4M16.5 6.5l-7 7" />
        <path strokeLinecap="round" strokeWidth={4} stroke="currentColor" strokeOpacity={0.3}
          d="M4 20h6" />
      </svg>
    ),
  },
  {
    id: "underline",
    label: "Underline",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M7 8v5a5 5 0 0010 0V8M5 20h14" />
      </svg>
    ),
  },
  {
    id: "strikethrough",
    label: "Strikethrough",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 7h6m-7 5h8M9 17h6" />
        <line x1={4} y1={12} x2={20} y2={12} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "note",
    label: "Note",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    id: "rect",
    label: "Rectangle",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <rect x={3} y={5} width={18} height={14} rx={1} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "circle",
    label: "Circle",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={9} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "text",
    label: "Text",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4 6h16M4 12h16M4 18h7" />
      </svg>
    ),
  },
];

export function AnnotationToolbar({
  activeTool,
  onToolChange,
  onExit,
  activeColor,
  onColorChange,
}: AnnotationToolbarProps) {
  const toolBtnStyle = (active: boolean): React.CSSProperties =>
    active
      ? {
          background: "var(--accent-soft)",
          border: "1px solid color-mix(in oklch, var(--accent) 50%, transparent)",
          color: "var(--accent)",
        }
      : {
          background: "transparent",
          border: "1px solid transparent",
          color: "var(--viewer-text-sec)",
        };

  return (
    <div
      className="flex items-center flex-wrap gap-1"
      style={{
        height: 44,
        flexShrink: 0,
        background: "var(--viewer-surface)",
        borderBottom: "1px solid var(--viewer-border)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 12px",
      }}
    >
      {/* Annotation tool buttons */}
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => onToolChange(activeTool === t.id ? null : t.id)}
          title={t.label}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
          style={toolBtnStyle(activeTool === t.id)}
        >
          {t.icon}
          <span className="hidden sm:inline">{t.label}</span>
        </button>
      ))}

      <Divider />

      {/* Color swatches */}
      <div className="flex items-center gap-1 px-1 shrink-0">
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c.value}
            onClick={() => onColorChange(c.value)}
            title={c.label}
            className="rounded-full shrink-0 transition-transform hover:scale-110"
            style={{
              width: "18px",
              height: "18px",
              background: c.value,
              outline: activeColor === c.value
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              outlineOffset: "1px",
              border: "none",
              cursor: "pointer",
            }}
          />
        ))}
        {/* Custom color input */}
        <label
          title="Custom color"
          className="relative shrink-0 cursor-pointer"
          style={{ width: "18px", height: "18px" }}
        >
          <div
            className="rounded-full w-full h-full"
            style={{
              background: activeColor,
              border: "2px dashed var(--viewer-border)",
              boxSizing: "border-box",
            }}
          />
          <input
            type="color"
            value={activeColor}
            onChange={(e) => onColorChange(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
          />
        </label>
      </div>

      <Divider />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Exit button */}
      <button
        onClick={onExit}
        title="Exit annotation mode"
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
        style={{
          background: "transparent",
          border: "1px solid transparent",
          color: "var(--viewer-text-sec)",
        }}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        <span className="hidden sm:inline">Exit</span>
      </button>
    </div>
  );
}
