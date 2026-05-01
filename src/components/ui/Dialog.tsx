import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(2px)",
            zIndex: 1000,
          }}
        />
        <RadixDialog.Content
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: "var(--bg1, #1e1e2e)",
            border: "1px solid var(--line, #313244)",
            borderRadius: 8,
            padding: 24,
            minWidth: 320,
            maxWidth: "90vw",
            maxHeight: "85vh",
            overflowY: "auto",
            zIndex: 1001,
            boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
          }}
        >
          {title && (
            <RadixDialog.Title
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 15,
                fontWeight: 600,
                color: "var(--fg0, #cdd6f4)",
                marginBottom: description ? 4 : 16,
              }}
            >
              {title}
            </RadixDialog.Title>
          )}
          {description && (
            <RadixDialog.Description
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 12,
                color: "var(--fg2, #6c7086)",
                marginBottom: 16,
              }}
            >
              {description}
            </RadixDialog.Description>
          )}
          {children}
          <RadixDialog.Close
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              width: 24,
              height: 24,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--fg2, #6c7086)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
            }}
            aria-label="Close"
          >
            <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
