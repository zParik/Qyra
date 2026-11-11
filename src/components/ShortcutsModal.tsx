import { Dialog } from "./ui/Dialog";

interface Shortcut {
  keys: string[];
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
      { keys: ["Ctrl+T"], desc: "New tab" },
      { keys: ["Ctrl+W"], desc: "Close tab" },
      { keys: ["Ctrl+Shift+T"], desc: "Reopen the last closed tab" },
      { keys: ["Ctrl+Tab"], desc: "Next tab" },
      { keys: ["Ctrl+Shift+Tab"], desc: "Previous tab" },
      { keys: ["Ctrl+1", "…", "Ctrl+8"], desc: "Jump to a tab" },
      { keys: ["Ctrl+9"], desc: "Jump to the last tab" },
      { keys: ["Ctrl+\\"], desc: "Split view: open or close" },
      { keys: ["Middle click"], desc: "Close tab" },
    ],
  },
  {
    title: "Reading",
    items: [
      { keys: ["↓", "→", "PageDown"], desc: "Next page" },
      { keys: ["↑", "←", "PageUp"], desc: "Previous page" },
      { keys: ["Home"], desc: "First page" },
      { keys: ["End"], desc: "Last page" },
      { keys: ["Ctrl+F"], desc: "Find in document" },
    ],
  },
  {
    title: "Zoom",
    items: [
      { keys: ["Ctrl+="], desc: "Zoom in" },
      { keys: ["Ctrl+-"], desc: "Zoom out" },
      { keys: ["Ctrl+0"], desc: "Reset zoom" },
      { keys: ["Ctrl+scroll"], desc: "Zoom at the pointer" },
    ],
  },
  {
    title: "File",
    items: [
      { keys: ["Ctrl+O"], desc: "Open a PDF" },
      { keys: ["Ctrl+S"], desc: "Save" },
      { keys: ["Ctrl+Shift+S"], desc: "Save as…" },
      { keys: ["Ctrl+P"], desc: "Print" },
      { keys: ["Ctrl+Z"], desc: "Undo" },
    ],
  },
  {
    title: "Everywhere",
    items: [
      { keys: ["Ctrl+K"], desc: "Command palette" },
      { keys: ["Ctrl+,"], desc: "Settings" },
      { keys: ["?"], desc: "This list" },
      { keys: ["Esc"], desc: "Close, or leave a mode" },
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
      description="Press ? at any time to open this list."
      width={760}
    >
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title} className="shortcuts-group">
            <h3 className="t-label" style={{ margin: "0 0 var(--space-2)" }}>{g.title}</h3>
            <dl className="shortcuts-list">
              {g.items.map((s) => (
                <div key={s.desc} className="shortcuts-row">
                  <dt>
                    {s.keys.map((k, i) => (
                      k === "…" ? <span key={i} className="t-meta">…</span> : <kbd key={i} className="kbd">{k}</kbd>
                    ))}
                  </dt>
                  <dd>{s.desc}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
