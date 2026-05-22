import type { ReactNode } from "react";
import { PanelOutput } from "../PanelOutput";
import type { ProgressData } from "../usePanelCommand";

interface ToolPanelLayoutProps {
  children: ReactNode;
  /** Optional submit handler. If provided, renders a primary button. */
  onSubmit?: () => void;
  submitLabel?: ReactNode;
  /** Button is also disabled when this is true. */
  isProcessing?: boolean;
  /** Extra disable condition for the submit button. */
  submitDisabled?: boolean;
  /** Submit button class override (default: "v-btn-primary"). */
  submitClassName?: string;

  /**
   * Standard `usePanelCommand` output wiring. Pass these straight from the
   * hook. When omitted, no output area renders — caller can render its own.
   */
  result?: string | string[] | null;
  error?: string | null;
  onClearError?: () => void;
  progress?: ProgressData | null;

  /** Slot rendered between submit button and PanelOutput (rarely used). */
  beforeOutput?: ReactNode;
}

/**
 * Common scaffold for a tool panel:
 *   <div class="space-y-4">
 *     {children}
 *     [submit button]
 *     [extra slot]
 *     <PanelOutput ... />
 *   </div>
 */
export function ToolPanelLayout({
  children,
  onSubmit,
  submitLabel,
  isProcessing = false,
  submitDisabled = false,
  submitClassName = "v-btn-primary",
  result = null,
  error = null,
  onClearError,
  progress = null,
  beforeOutput,
}: ToolPanelLayoutProps) {
  return (
    <div className="space-y-4">
      {children}
      {onSubmit && submitLabel != null && (
        <button
          onClick={onSubmit}
          disabled={isProcessing || submitDisabled}
          className={submitClassName}
        >
          {submitLabel}
        </button>
      )}
      {beforeOutput}
      <PanelOutput
        isProcessing={isProcessing}
        result={result}
        error={error}
        onClearError={onClearError}
        progress={progress}
      />
    </div>
  );
}
