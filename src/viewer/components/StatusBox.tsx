import type { ReactNode } from "react";
import { IconCheck } from "../icons";

type Status = "error" | "success" | "info";

interface StatusBoxProps {
  status: Status;
  message: ReactNode;
  /** Optional secondary content (extra paragraph, button, etc). */
  detail?: ReactNode;
  /** Label shown next to the icon (success: "Done", error: "Error"). Optional override. */
  title?: ReactNode;
  /** When provided on an error, renders a "Dismiss" link. */
  onDismiss?: () => void;
  /** Optional className override (default: "mt-3"). */
  marginTopClass?: string;
}

/**
 * Unified status box used for error / success / info results.
 * Replaces the inline duplicates in CompressPanel, RedactPanel, WatermarkPanel, etc.
 *
 * Visuals preserved exactly:
 *  - error  → v-panel-bad + var(--v-bad-text)
 *  - success → v-panel-ok  + var(--v-ok-text), with check icon
 *  - info   → v-panel-ok  with toned-down text (no icon)
 */
export function StatusBox({
  status,
  message,
  detail,
  title,
  onDismiss,
  marginTopClass = "mt-3",
}: StatusBoxProps) {
  if (status === "error") {
    return (
      <div className={`${marginTopClass} v-panel-bad space-y-1.5`}>
        <p className="text-xs font-semibold" style={{ color: "var(--v-bad-text)" }}>
          {title ?? "Error"}
        </p>
        <p className="text-xs wrap-break-word" style={{ color: "var(--v-bad-text)", opacity: 0.9 }}>
          {message}
        </p>
        {detail}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-xs underline"
            style={{ color: "var(--v-bad-text)" }}
          >
            Dismiss
          </button>
        )}
      </div>
    );
  }

  // success / info share styling
  return (
    <div className={`${marginTopClass} v-panel-ok space-y-1.5`}>
      <div className="flex items-center gap-1.5" style={{ color: "var(--v-ok-text)" }}>
        {status === "success" && <IconCheck className="w-4 h-4 shrink-0" />}
        <span className="text-xs font-semibold">{title ?? (status === "success" ? "Done" : "")}</span>
      </div>
      {message && (
        <p className="text-xs" style={{ color: "var(--v-ok-text)", opacity: 0.85 }}>
          {message}
        </p>
      )}
      {detail}
    </div>
  );
}
