import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/useAppStore";
import { useTheme } from "../lib/useTheme";
import type { RecentFile } from "../lib/schemas";
import { RecentFileSchema } from "../lib/schemas";
import { IcSearch } from "./Icons";

const RECENT_KEY = "qyra-recent";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Tabs" | "Recent files" | "Tools" | "Appearance";
  run: () => void | Promise<void>;
}

function loadRecent(): RecentFile[] {
  try { return RecentFileSchema.array().parse(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")); }
  catch { return []; }
}

function fuzzyScore(target: string, query: string): number {
  if (!query) return 1;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500;
  if (t.includes(q)) return 200;
  // sub-sequence match
  let ti = 0, matched = 0;
  for (let qi = 0; qi < q.length; qi++) {
    while (ti < t.length && t[ti] !== q[qi]) ti++;
    if (ti >= t.length) return 0;
    matched++; ti++;
  }
  return matched === q.length ? 50 : 0;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { cycle: cycleTheme } = useTheme();

  const openTabs = useAppStore((s) => s.openTabs);
  const activateTab = useAppStore((s) => s.activateTab);
  const openTab = useAppStore((s) => s.openTab);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // Block global shortcut handler from also firing when palette is open
      if (open && inField) return;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, navigate]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  async function browseAndOpen() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0]! : selected;
    const name = path.split(/[\\/]/).pop() ?? path;
    openTab({ type: "pdf", path, name });
    setTabOriginal(path, path);
    setTabDirty(path, false);
    setTabUndo(path, null);
    navigate("/view");
  }

  function openRecent(file: RecentFile) {
    openTab({ type: "pdf", path: file.path, name: file.name });
    setTabOriginal(file.path, file.path);
    setTabDirty(file.path, false);
    setTabUndo(file.path, null);
    navigate("/view");
  }

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "nav:home", label: "Go to the library", group: "Navigate", run: () => navigate("/") },
      { id: "nav:view", label: "Go to the viewer", group: "Navigate", run: () => navigate("/view") },
      { id: "nav:merge", label: "Merge PDFs", group: "Navigate", hint: "Ctrl+M", run: () => navigate("/merge") },
      { id: "nav:images-to-pdf", label: "Images to PDF", group: "Navigate", hint: "Ctrl+I", run: () => navigate("/images-to-pdf") },
      { id: "nav:ocr", label: "Make searchable (OCR)", group: "Navigate", run: () => navigate("/ocr") },
      { id: "nav:repair", label: "Repair PDF", group: "Navigate", run: () => navigate("/repair") },
      { id: "nav:batch", label: "Batch operations", group: "Navigate", run: () => navigate("/batch") },
      { id: "nav:settings", label: "Settings", group: "Navigate", hint: "Ctrl+,", run: () => navigate("/settings") },

      { id: "file:open", label: "Open a PDF…", group: "Tools", hint: "Ctrl+O", run: browseAndOpen },
      { id: "ui:theme", label: "Switch theme (light, dark, system)", group: "Appearance", run: cycleTheme },
    ];

    openTabs.forEach((tab, i) => {
      if (tab.type === "home") return;
      list.push({
        id: `tab:${tab.path}`,
        label: `Switch to ${tab.name}`,
        hint: `Ctrl+${i + 1}`,
        group: "Tabs",
        run: () => { activateTab(i); navigate("/view"); },
      });
    });

    loadRecent().slice(0, 8).forEach((file) => {
      list.push({
        id: `recent:${file.path}`,
        label: file.name,
        hint: file.path,
        group: "Recent files",
        run: () => openRecent(file),
      });
    });

    return list;
  }, [openTabs, navigate, cycleTheme]);

  const filtered = useMemo(() => {
    if (!query) return commands;
    return commands
      .map((c) => ({ c, score: Math.max(fuzzyScore(c.label, query), fuzzyScore(c.hint ?? "", query) * 0.5) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [query, commands]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  function handleInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) { setOpen(false); cmd.run(); }
    }
  }

  if (!open) return null;

  const groups = new Map<string, Command[]>();
  filtered.forEach((cmd) => {
    const arr = groups.get(cmd.group) ?? [];
    arr.push(cmd);
    groups.set(cmd.group, arr);
  });

  let runningIndex = -1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      className="palette-overlay"
    >
      <div onClick={(e) => e.stopPropagation()} className="pop palette">
        <div className="palette-field">
          <IcSearch size={16} style={{ color: "var(--fg2)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleInputKey}
            placeholder="Search commands, tabs and recent files…"
            aria-label="Search commands"
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox">
          {filtered.length === 0 && <div className="palette-empty">Nothing matches that.</div>}
          {[...groups.entries()].map(([group, items]) => (
            <div key={group} className="palette-group">
              <div className="t-label palette-group-head">{group}</div>
              {items.map((cmd) => {
                runningIndex++;
                const idx = runningIndex; // snapshot — closures below must not read the mutating let
                const active = idx === activeIndex;
                return (
                  <div
                    key={cmd.id}
                    role="option"
                    aria-selected={active}
                    className="menu-item"
                    data-highlighted={active ? "" : undefined}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => { setOpen(false); cmd.run(); }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cmd.label}
                    </span>
                    {cmd.hint && (
                      cmd.group === "Recent files"
                        ? <span className="palette-path">{cmd.hint}</span>
                        : <kbd className="kbd">{cmd.hint}</kbd>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd">Enter</kbd> run</span>
          <span><kbd className="kbd">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
