import { Dialog } from "./ui/Dialog";
import { UI, MONO } from "../lib/tokens";

interface Shortcut {
  keys: string;
  desc: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

const GROUPS: Group[] = [
  {
    title: "Tabs",
    items: [
      { keys: "Ctrl+T", desc: "New tab" },
      { keys: "Ctrl+W", desc: "Close tab" },
      { keys: "Ctrl+Shift+T", desc: "Reopen last closed tab" },
      { keys: "Ctrl+Tab", desc: "Next tab" },
      { keys: "Ctrl+Shift+Tab", desc: "Previous tab" },
      { keys: "Ctrl+1..8", desc: "Jump to tab N" },
      { keys: "Ctrl+9", desc: "Jump to last tab" },
      { keys: "Middle-click", desc: "Close tab" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: "↓ / →  / PageDown", desc: "Next page" },
      { keys: "↑ / ←  / PageUp", desc: "Previous page" },
      { keys: "Home", desc: "First page" },
      { keys: "End", desc: "Last page" },
    ],
  },
  {
    title: "Zoom",
    items: [
      { keys: "Ctrl+=", desc: "Zoom in" },
      { keys: "Ctrl+-", desc: "Zoom out" },
      { keys: "Ctrl+0", desc: "Reset zoom" },
    ],
  },
  {
    title: "File",
    items: [
      { keys: "Ctrl+S", desc: "Save" },
      { keys: "Ctrl+Shift+S", desc: "Save as…" },
      { keys: "Ctrl+P", desc: "Print" },
      { keys: "Ctrl+Z", desc: "Undo" },
      { keys: "Ctrl+F", desc: "Find in document" },
    ],
  },
  {
    title: "Help",
    items: [
      { keys: "?", desc: "Show this cheatsheet" },
      { keys: "Esc", desc: "Close modal / exit mode" },
    ],
  },
];

export function ShortcutsModal({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Press ? at any time to bring this up."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 20,
          fontFamily: UI,
          fontSize: 12,
          color: "var(--fg1, #cdd6f4)",
          minWidth: 560,
        }}
      >
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3
              style={{
                margin: "0 0 8px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--fg2, #6c7086)",
              }}
            >
              {g.title}
            </h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {g.items.map((s) => (
                  <tr key={s.keys}>
                    <td
                      style={{
                        padding: "4px 8px 4px 0",
                        fontFamily: MONO,
                        fontSize: 11,
                        color: "var(--fg0, #cdd6f4)",
                        whiteSpace: "nowrap",
                        verticalAlign: "top",
                      }}
                    >
                      {s.keys}
                    </td>
                    <td style={{ padding: "4px 0", color: "var(--fg2, #a6adc8)" }}>
                      {s.desc}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
