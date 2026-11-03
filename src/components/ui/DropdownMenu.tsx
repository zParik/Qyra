import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Keyboard hint shown right-aligned, e.g. "Ctrl+S". */
  shortcut?: string;
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
        <RadixDropdown.Content className="pop menu" side={side} align={align} sideOffset={6} style={{ zIndex: 9000 }}>
          {items.map((item, i) => (
            <RadixDropdown.Item
              key={i}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="menu-item"
              data-destructive={item.destructive ? "true" : undefined}
            >
              {item.icon && <span className="menu-icon">{item.icon}</span>}
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}
