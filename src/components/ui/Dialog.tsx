import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { useIsPhone } from "../../hooks/useMediaQuery";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  const isPhone = useIsPhone();

  const contentStyle: React.CSSProperties = isPhone
    ? {
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        background: "var(--bg1, #1e1e2e)",
        borderTop: "1px solid var(--line, #313244)",
        borderLeft: "1px solid var(--line, #313244)",
        borderRight: "1px solid var(--line, #313244)",
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 20,
        paddingTop: 28,
        paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
        maxHeight: "85dvh",
        overflowY: "auto",
        zIndex: 1001,
        boxShadow: "0 -16px 48px rgba(0,0,0,0.5)",
        animation: "dialog-slide-up 220ms cubic-bezier(0.22, 1, 0.36, 1)",
      }
    : {
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
      };

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
        <RadixDialog.Content style={contentStyle}>
          {isPhone && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 8,
                left: "50%",
                transform: "translateX(-50%)",
                width: 36,
                height: 4,
                borderRadius: 2,
                background: "var(--line)",
              }}
            />
          )}
          {title && (
            <RadixDialog.Title
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: isPhone ? 17 : 15,
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
                fontSize: isPhone ? 13 : 12,
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
              top: isPhone ? 18 : 12,
              right: isPhone ? 14 : 12,
              width: isPhone ? 40 : 24,
              height: isPhone ? 40 : 24,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--fg2, #6c7086)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label="Close"
          >
            <svg width={isPhone ? 20 : 14} height={isPhone ? 20 : 14} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogTrigger = RadixDialog.Trigger;
