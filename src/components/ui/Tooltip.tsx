import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}

export function Tooltip({ content, children, side = "top", delayDuration = 600 }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            style={{
              background: "var(--bg2, #1e1e2e)",
              color: "var(--fg0, #cdd6f4)",
              border: "1px solid var(--line, #313244)",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 11,
              fontFamily: "'Inter', system-ui, sans-serif",
              lineHeight: 1.4,
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              maxWidth: 240,
              zIndex: 9999,
            }}
          >
            {content}
            <RadixTooltip.Arrow style={{ fill: "var(--line, #313244)" }} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
