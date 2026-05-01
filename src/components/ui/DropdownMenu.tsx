import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode, CSSProperties } from "react";

const contentStyle: CSSProperties = {
  background: "var(--bg2, #181825)",
  border: "1px solid var(--line, #313244)",
  borderRadius: 6,
  padding: "4px 0",
  minWidth: 160,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  zIndex: 9000,
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  fontSize: 12,
  fontFamily: "'Inter', system-ui, sans-serif",
  color: "var(--fg0, #cdd6f4)",
  cursor: "pointer",
  outline: "none",
  borderRadius: 0,
};

export interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownItem[];
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function DropdownMenu({ trigger, items, side = "bottom", align = "start" }: DropdownMenuProps) {
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>{trigger}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content style={contentStyle} side={side} align={align} sideOffset={4}>
          {items.map((item, i) => (
            <RadixDropdown.Item
              key={i}
              disabled={item.disabled}
              onSelect={item.onSelect}
              style={{
                ...itemStyle,
                color: item.destructive ? "var(--v-bad-text, #ef4444)" : itemStyle.color,
                opacity: item.disabled ? 0.4 : 1,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg3, #313244)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {item.icon && <span style={{ flexShrink: 0, opacity: 0.7 }}>{item.icon}</span>}
              {item.label}
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}
