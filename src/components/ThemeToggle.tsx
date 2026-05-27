import type { ReactElement } from "react";
import { useTheme, ThemeChoice } from "../lib/useTheme";
import { UI } from "../lib/tokens";

const LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const ICONS: Record<ThemeChoice, ReactElement> = {
  light: (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M3.3 12.7l1.1-1.1M11.6 4.4l1.1-1.1" />
    </svg>
  ),
  dark: (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
    </svg>
  ),
  system: (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  ),
};

interface Props {
  variant?: "rail" | "compact";
}

export function ThemeToggle({ variant = "compact" }: Props) {
  const { theme, cycle } = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";

  if (variant === "rail") {
    return (
      <button
        onClick={cycle}
        title={`Theme: ${LABELS[theme]} (click for ${LABELS[next]})`}
        aria-label={`Theme: ${LABELS[theme]}. Click to switch to ${LABELS[next]}.`}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "6px 8px",
          background: "transparent",
          border: "1px solid var(--line)",
          borderRadius: 4,
          color: "var(--fg1)",
          fontFamily: UI, fontSize: 11.5,
          cursor: "pointer",
        }}
      >
        <span style={{ display: "inline-flex" }}>{ICONS[theme]}</span>
        <span style={{ flex: 1, textAlign: "left" }}>{LABELS[theme]}</span>
      </button>
    );
  }

  return (
    <button
      onClick={cycle}
      title={`Theme: ${LABELS[theme]} (click for ${LABELS[next]})`}
      aria-label={`Theme: ${LABELS[theme]}. Click to switch to ${LABELS[next]}.`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 8px",
        background: "transparent",
        border: "1px solid var(--line)",
        borderRadius: 4,
        color: "var(--fg1)",
        fontFamily: UI, fontSize: 11,
        cursor: "pointer",
      }}
    >
      {ICONS[theme]}
      <span>{LABELS[theme]}</span>
    </button>
  );
}
