import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Content width; defaults to a comfortable reading column. */
  width?: number;
}

export function Dialog({ open, onOpenChange, title, description, children, width = 440 }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "oklch(0.15 0.03 265 / 0.45)",
            zIndex: 1000,
            animation: "fade-in var(--dur-2) var(--ease-out)",
          }}
        />
        <RadixDialog.Content
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(90vw, " + width + "px)",
            maxHeight: "85vh",
            overflowY: "auto",
            background: "var(--bg2)",
            color: "var(--fg0)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-3)",
            boxShadow: "var(--shadow-dialog)",
            padding: "var(--space-6)",
            zIndex: 1001,
            animation: "pop-in var(--dur-2) var(--ease-out)",
          }}
        >
          {title && (
            <RadixDialog.Title
              style={{
                fontSize: "var(--fs-title)",
                fontWeight: 600,
                lineHeight: "var(--lh-tight)",
                letterSpacing: "-0.01em",
                margin: 0,
                marginBottom: description ? "var(--space-1)" : "var(--space-4)",
                paddingRight: 32,
              }}
            >
              {title}
            </RadixDialog.Title>
          )}
          {description && (
            <RadixDialog.Description
              style={{ fontSize: "var(--fs-body)", color: "var(--fg1)", margin: 0, marginBottom: "var(--space-4)" }}
            >
              {description}
            </RadixDialog.Description>
          )}
          {children}
          <RadixDialog.Close
            className="btn-icon"
            style={{ position: "absolute", top: 12, right: 12, width: 28, height: 28 }}
            aria-label="Close"
          >
            <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 16 16" aria-hidden="true">
              <path strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
