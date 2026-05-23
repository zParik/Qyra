# Multiple Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `viewerFile` in the store with an `openTabs` array so multiple PDFs can be open simultaneously, each with full state preservation when switching.

**Architecture:** All tab Viewer instances stay mounted using `visibility: hidden` (not `display: none`) so virtual-scroll dimensions are preserved. The existing `LibraryDb` SQLite connection gets two new tables for session persistence. Viewer receives a `tabPath` prop and reads/writes per-path keyed store slices instead of the old single-file scalars.

**Tech Stack:** Rust + rusqlite (already bundled), Zustand 5, React 19, @dnd-kit/sortable (already in project), Tauri 2 invoke.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/src/commands/library.rs` | Modify | Add tab table DDL to `DB_SCHEMA` |
| `src-tauri/src/commands/tabs.rs` | Create | 4 Tauri commands for tab session + UI state |
| `src-tauri/src/commands/mod.rs` | Modify | `pub mod tabs;` |
| `src-tauri/src/lib.rs` | Modify | Register 4 tab commands in `invoke_handler!` |
| `src/store/useAppStore.ts` | Modify | Replace `viewerFile` scalars with `openTabs[]` + per-path maps |
| `src/viewer/TabBar.tsx` | Create | Tab pill UI with close, dnd-kit reorder, + button |
| `src/viewer/ViewerShell.tsx` | Create | Absolute-stack of Viewers + keyboard shortcuts + session load |
| `src/viewer/Viewer.tsx` | Modify | Accept `tabPath` prop; per-tab store reads; SQLite page/zoom sync |
| `src/App.tsx` | Modify | Route `/view` → `<ViewerShell>` |
| `src/hooks/useOpenWithFile.ts` | Modify | `openTab()` when tabs already exist |

---

### Task 1: Extend DB schema with tab tables

**Files:**
- Modify: `src-tauri/src/commands/library.rs`

The existing `DB_SCHEMA` constant runs at startup via `execute_batch`. Append the two tab tables so they're created automatically.

- [ ] **Step 1: Add tab DDL to DB_SCHEMA**

Open `src-tauri/src/commands/library.rs`. Find the `DB_SCHEMA` constant (currently ends after the `settings` table). Replace it:

```rust
const DB_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS library (
        path     TEXT    PRIMARY KEY,
        name     TEXT    NOT NULL,
        starred  INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS open_tabs (
        position  INTEGER NOT NULL,
        path      TEXT    NOT NULL UNIQUE,
        name      TEXT    NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tab_ui_state (
        path         TEXT    PRIMARY KEY,
        current_page INTEGER NOT NULL DEFAULT 1,
        zoom         REAL    NOT NULL DEFAULT 1.0,
        updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );";
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/library.rs
git commit -m "feat(db): add open_tabs and tab_ui_state tables to schema"
```

---

### Task 2: Create tabs.rs with 4 Rust commands

**Files:**
- Create: `src-tauri/src/commands/tabs.rs`

All commands reuse the already-managed `LibraryDb` state. This is the same pattern as `library.rs` commands.

- [ ] **Step 1: Write the file**

Create `src-tauri/src/commands/tabs.rs`:

```rust
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use super::library::LibraryDb;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    pub path: String,
    pub name: String,
}

fn lock(db: &State<LibraryDb>) -> AppResult<std::sync::MutexGuard<Connection>> {
    db.0.lock().map_err(|e| AppError::Lock(e.to_string()))
}

/// Load persisted tab session. Returns tabs ordered by position.
#[tauri::command]
pub fn get_tab_session(db: State<LibraryDb>) -> AppResult<(Vec<TabEntry>, i32)> {
    let conn = lock(&db)?;
    let mut stmt = conn.prepare(
        "SELECT path, name, is_active FROM open_tabs ORDER BY position ASC",
    )?;
    let mut tabs = Vec::new();
    let mut active: i32 = 0;
    let rows = stmt.query_map([], |r| {
        Ok((
            TabEntry { path: r.get(0)?, name: r.get(1)? },
            r.get::<_, i32>(2)?,
        ))
    })?;
    for (i, row) in rows.enumerate() {
        let (entry, is_active) = row?;
        if is_active != 0 {
            active = i as i32;
        }
        tabs.push(entry);
    }
    Ok((tabs, active))
}

/// Persist the full tab list and which index is active.
#[tauri::command]
pub fn save_tab_session(
    db: State<LibraryDb>,
    tabs: Vec<TabEntry>,
    active_index: i32,
) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM open_tabs", [])?;
    for (i, tab) in tabs.iter().enumerate() {
        let is_active = if i as i32 == active_index { 1 } else { 0 };
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (?1, ?2, ?3, ?4)",
            params![i as i32, tab.path, tab.name, is_active],
        )?;
    }
    Ok(())
}

/// Upsert per-file page position and zoom. Debounce this call on the frontend.
#[tauri::command]
pub fn save_tab_ui_state(
    db: State<LibraryDb>,
    path: String,
    current_page: i32,
    zoom: f64,
) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))
         ON CONFLICT(path) DO UPDATE SET
           current_page = excluded.current_page,
           zoom         = excluded.zoom,
           updated_at   = excluded.updated_at",
        params![path, current_page, zoom],
    )?;
    Ok(())
}

/// Read saved page + zoom for a single path. Returns (1, 1.0) if not found.
#[tauri::command]
pub fn get_tab_ui_state(db: State<LibraryDb>, path: String) -> AppResult<(i32, f64)> {
    let conn = lock(&db)?;
    let result = conn.query_row(
        "SELECT current_page, zoom FROM tab_ui_state WHERE path = ?1",
        params![path],
        |r| Ok((r.get::<_, i32>(0)?, r.get::<_, f64>(1)?)),
    );
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok((1, 1.0)),
        Err(e) => Err(e.into()),
    }
}

/// Remove all open_tabs rows (called when user closes all tabs).
#[tauri::command]
pub fn clear_tab_session(db: State<LibraryDb>) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM open_tabs", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE open_tabs (
                position INTEGER NOT NULL,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tab_ui_state (
                path TEXT PRIMARY KEY,
                current_page INTEGER NOT NULL DEFAULT 1,
                zoom REAL NOT NULL DEFAULT 1.0,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
        ").unwrap();
        conn
    }

    #[test]
    fn save_and_load_session() {
        let conn = setup();
        // Insert two tabs
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (0, '/a.pdf', 'a.pdf', 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (1, '/b.pdf', 'b.pdf', 1)",
            [],
        ).unwrap();

        let mut stmt = conn.prepare(
            "SELECT path, name, is_active FROM open_tabs ORDER BY position ASC",
        ).unwrap();
        let rows: Vec<(String, String, i32)> = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        }).unwrap().map(|r| r.unwrap()).collect();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "/a.pdf");
        assert_eq!(rows[1].2, 1); // second tab is active
    }

    #[test]
    fn upsert_tab_ui_state() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
             VALUES ('/a.pdf', 5, 1.5, strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET
               current_page = excluded.current_page,
               zoom = excluded.zoom,
               updated_at = excluded.updated_at",
            [],
        ).unwrap();
        // Upsert again
        conn.execute(
            "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
             VALUES ('/a.pdf', 10, 2.0, strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET
               current_page = excluded.current_page,
               zoom = excluded.zoom,
               updated_at = excluded.updated_at",
            [],
        ).unwrap();
        let (page, zoom): (i32, f64) = conn.query_row(
            "SELECT current_page, zoom FROM tab_ui_state WHERE path = '/a.pdf'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(page, 10);
        assert!((zoom - 2.0).abs() < 0.001);
    }

    #[test]
    fn clear_session() {
        let conn = setup();
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (0, '/a.pdf', 'a.pdf', 1)",
            [],
        ).unwrap();
        conn.execute("DELETE FROM open_tabs", []).unwrap();
        let count: i32 = conn.query_row("SELECT COUNT(*) FROM open_tabs", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
```

- [ ] **Step 2: Run Rust tests**

In VS Developer PowerShell:
```
cargo test -p qyra tabs::tests
```
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/tabs.rs
git commit -m "feat(tabs): add SQLite commands for tab session and UI state"
```

---

### Task 3: Wire tabs.rs into mod.rs and lib.rs

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/commands/mod.rs`, add after `export_word`:

```rust
pub mod tabs;
```

- [ ] **Step 2: Register commands in lib.rs**

In `src-tauri/src/lib.rs`, inside the `invoke_handler!` list, add after `export_word::export_pdf_to_word`:

```rust
tabs::get_tab_session,
tabs::save_tab_session,
tabs::save_tab_ui_state,
tabs::get_tab_ui_state,
tabs::clear_tab_session,
```

- [ ] **Step 3: Build check**

In VS Developer PowerShell:
```
cargo build
```
Expected: compiles without error.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(tabs): register tab commands in invoke handler"
```

---

### Task 4: Refactor useAppStore.ts

**Files:**
- Modify: `src/store/useAppStore.ts`

Replace the four single-file scalars (`viewerFile`, `undoViewerFile`, `originalViewerPath`, `isViewerDirty`) with `openTabs` + `activeTabIndex` and per-path Record maps. Keep the old setter names as thin wrappers so call sites inside panels continue to compile — we'll migrate Viewer itself in Task 7.

- [ ] **Step 1: Replace the file**

```typescript
import { create } from "zustand";
import { PdfInfo } from "../lib/tauri";

export interface LoadedFile {
  path: string;
  name: string;
  info?: PdfInfo;
  thumbnail?: string;
}

export interface TabEntry {
  path: string;
  name: string;
  info?: PdfInfo;
  thumbnail?: string;
}

export type Tool =
  | "merge" | "split" | "compress" | "rotate" | "remove"
  | "reorder" | "pdf-to-images" | "images-to-pdf"
  | "page-numbers" | "protect" | "unlock" | "metadata";

interface AppState {
  // Multi-file tools
  files: LoadedFile[];
  currentTool: Tool | null;
  result: string | null;
  resultFiles: string[];
  isProcessing: boolean;
  progress: { current: number; total: number; message: string } | null;
  error: string | null;
  cancelFn: (() => void) | null;

  // Multi-tab viewer
  openTabs: TabEntry[];
  activeTabIndex: number; // -1 = no tabs open

  // Per-path keyed state (path → value)
  tabFiles: Record<string, LoadedFile>;
  tabUndo: Record<string, LoadedFile | null>;
  tabOriginal: Record<string, string>;
  tabDirty: Record<string, boolean>;

  // Legacy shims — kept as real state fields, synced on each tab action,
  // so any remaining call sites (panel callbacks inside Viewer etc.) still compile.
  viewerFile: LoadedFile | null;
  undoViewerFile: LoadedFile | null;
  originalViewerPath: string | null;
  isViewerDirty: boolean;

  // Multi-file tool actions
  setCancelFn: (fn: (() => void) | null) => void;
  setFiles: (files: LoadedFile[]) => void;
  addFile: (file: LoadedFile) => void;
  removeFile: (path: string) => void;
  reorderFiles: (fromIndex: number, toIndex: number) => void;
  clearFiles: () => void;
  setCurrentTool: (tool: Tool | null) => void;
  setResult: (result: string | null) => void;
  setResultFiles: (files: string[]) => void;
  setIsProcessing: (v: boolean) => void;
  setProgress: (p: { current: number; total: number; message: string } | null) => void;
  setError: (e: string | null) => void;
  reset: () => void;

  // Tab actions
  openTab: (entry: TabEntry) => void;
  closeTab: (index: number) => void;
  activateTab: (index: number) => void;
  reorderTab: (from: number, to: number) => void;
  setTabFile: (path: string, file: LoadedFile) => void;
  setTabUndo: (path: string, file: LoadedFile | null) => void;
  setTabOriginal: (path: string, p: string) => void;
  setTabDirty: (path: string, v: boolean) => void;

  // Legacy shim setters — sync both per-path maps AND the legacy scalar fields
  setViewerFile: (file: LoadedFile | null) => void;
  setUndoViewerFile: (file: LoadedFile | null) => void;
  setOriginalViewerPath: (path: string | null) => void;
  setIsViewerDirty: (v: boolean) => void;
}

/** Recompute the four legacy scalars from current state — called after every tab action. */
function legacySync(s: Pick<AppState, "openTabs" | "activeTabIndex" | "tabFiles" | "tabUndo" | "tabOriginal" | "tabDirty">) {
  const tab = s.openTabs[s.activeTabIndex];
  return {
    viewerFile: tab ? (s.tabFiles[tab.path] ?? tab) : null,
    undoViewerFile: tab ? (s.tabUndo[tab.path] ?? null) : null,
    originalViewerPath: tab ? (s.tabOriginal[tab.path] ?? null) : null,
    isViewerDirty: tab ? (s.tabDirty[tab.path] ?? false) : false,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  files: [],
  currentTool: null,
  result: null,
  resultFiles: [],
  isProcessing: false,
  progress: null,
  error: null,
  cancelFn: null,

  openTabs: [],
  activeTabIndex: -1,
  tabFiles: {},
  tabUndo: {},
  tabOriginal: {},
  tabDirty: {},

  viewerFile: null,
  undoViewerFile: null,
  originalViewerPath: null,
  isViewerDirty: false,

  setCancelFn: (cancelFn) => set({ cancelFn }),
  setFiles: (files) => set({ files }),
  addFile: (file) => set((s) => ({ files: [...s.files, file] })),
  removeFile: (path) => set((s) => ({ files: s.files.filter((f) => f.path !== path) })),
  reorderFiles: (fromIndex, toIndex) =>
    set((s) => {
      const files = [...s.files];
      const [moved] = files.splice(fromIndex, 1);
      if (moved) files.splice(toIndex, 0, moved);
      return { files };
    }),
  clearFiles: () => set({ files: [] }),
  setCurrentTool: (tool) => set({ currentTool: tool, result: null, resultFiles: [], error: null }),
  setResult: (result) => set({ result }),
  setResultFiles: (resultFiles) => set({ resultFiles }),
  setIsProcessing: (isProcessing) => set({ isProcessing }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  reset: () => set({ result: null, resultFiles: [], error: null, isProcessing: false, progress: null, cancelFn: null }),

  openTab: (entry) =>
    set((s) => {
      const existing = s.openTabs.findIndex((t) => t.path === entry.path);
      if (existing !== -1) {
        const next = { ...s, activeTabIndex: existing };
        return { activeTabIndex: existing, ...legacySync(next) };
      }
      const newTabs = [...s.openTabs, entry];
      const next = {
        openTabs: newTabs,
        activeTabIndex: newTabs.length - 1,
        tabFiles: { ...s.tabFiles, [entry.path]: entry },
        tabOriginal: { ...s.tabOriginal, [entry.path]: entry.path },
        tabUndo: s.tabUndo,
        tabDirty: s.tabDirty,
      };
      return { ...next, ...legacySync(next) };
    }),

  closeTab: (index) =>
    set((s) => {
      const tab = s.openTabs[index];
      const newTabs = s.openTabs.filter((_, i) => i !== index);
      let newActive = s.activeTabIndex;
      if (newActive >= newTabs.length) newActive = newTabs.length - 1;
      const tabFiles = { ...s.tabFiles };
      const tabUndo = { ...s.tabUndo };
      const tabOriginal = { ...s.tabOriginal };
      const tabDirty = { ...s.tabDirty };
      if (tab) {
        delete tabFiles[tab.path];
        delete tabUndo[tab.path];
        delete tabOriginal[tab.path];
        delete tabDirty[tab.path];
      }
      const next = { openTabs: newTabs, activeTabIndex: newActive, tabFiles, tabUndo, tabOriginal, tabDirty };
      return { ...next, ...legacySync(next) };
    }),

  activateTab: (index) =>
    set((s) => {
      const next = { ...s, activeTabIndex: index };
      return { activeTabIndex: index, ...legacySync(next) };
    }),

  reorderTab: (from, to) =>
    set((s) => {
      const tabs = [...s.openTabs];
      const [moved] = tabs.splice(from, 1);
      if (moved) tabs.splice(to, 0, moved);
      let newActive = s.activeTabIndex;
      if (s.activeTabIndex === from) newActive = to;
      else if (s.activeTabIndex > from && s.activeTabIndex <= to) newActive--;
      else if (s.activeTabIndex < from && s.activeTabIndex >= to) newActive++;
      const next = { ...s, openTabs: tabs, activeTabIndex: newActive };
      return { openTabs: tabs, activeTabIndex: newActive, ...legacySync(next) };
    }),

  setTabFile: (path, file) =>
    set((s) => {
      const tabFiles = { ...s.tabFiles, [path]: file };
      const next = { ...s, tabFiles };
      return { tabFiles, ...legacySync(next) };
    }),
  setTabUndo: (path, file) =>
    set((s) => {
      const tabUndo = { ...s.tabUndo, [path]: file };
      const next = { ...s, tabUndo };
      return { tabUndo, ...legacySync(next) };
    }),
  setTabOriginal: (path, p) =>
    set((s) => {
      const tabOriginal = { ...s.tabOriginal, [path]: p };
      const next = { ...s, tabOriginal };
      return { tabOriginal, ...legacySync(next) };
    }),
  setTabDirty: (path, v) =>
    set((s) => {
      const tabDirty = { ...s.tabDirty, [path]: v };
      const next = { ...s, tabDirty };
      return { tabDirty, ...legacySync(next) };
    }),

  // Legacy shim setters — write both the per-path map AND keep scalars in sync
  setViewerFile: (file) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab || !file) return;
    set((st) => {
      const tabFiles = { ...st.tabFiles, [tab.path]: file };
      return { tabFiles, viewerFile: file };
    });
  },
  setUndoViewerFile: (file) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab) return;
    set((st) => ({ tabUndo: { ...st.tabUndo, [tab.path]: file }, undoViewerFile: file }));
  },
  setOriginalViewerPath: (p) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab || !p) return;
    set((st) => ({ tabOriginal: { ...st.tabOriginal, [tab.path]: p }, originalViewerPath: p }));
  },
  setIsViewerDirty: (v) => {
    const s = get();
    const tab = s.openTabs[s.activeTabIndex];
    if (!tab) return;
    set((st) => ({ tabDirty: { ...st.tabDirty, [tab.path]: v }, isViewerDirty: v }));
  },
}));
```

- [ ] **Step 2: Check TypeScript compiles**

```
npx tsc --noEmit
```

Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/store/useAppStore.ts
git commit -m "feat(store): replace viewerFile with openTabs + per-path state maps"
```

---

### Task 5: Create TabBar.tsx

**Files:**
- Create: `src/viewer/TabBar.tsx`

Uses `@dnd-kit/sortable` (already installed). Renders one pill per tab, active tab highlighted, close button per tab, + button at the end.

- [ ] **Step 1: Create the file**

```tsx
import {
  DndContext, PointerSensor, useSensor, useSensors,
  closestCenter, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, horizontalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "../store/useAppStore";
import { UI } from "../lib/tokens";

function TabPill({
  id, label, active, onActivate, onClose,
}: {
  id: string; label: string; active: boolean;
  onActivate: () => void; onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 10px 0 12px",
        height: 32,
        borderRadius: 6,
        cursor: "pointer",
        flexShrink: 0,
        maxWidth: 200,
        background: active ? "var(--bg3)" : "transparent",
        border: active ? "1px solid var(--line)" : "1px solid transparent",
        color: active ? "var(--fg0)" : "var(--fg2)",
        fontFamily: UI,
        fontSize: 12,
        userSelect: "none",
      }}
      onClick={onActivate}
      {...attributes}
      {...listeners}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {label}
      </span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--fg2)", padding: "0 2px", lineHeight: 1,
          fontSize: 14, borderRadius: 3,
          flexShrink: 0,
        }}
        aria-label="Close tab"
      >
        ×
      </button>
    </div>
  );
}

export function TabBar({ onOpenFile, onCloseTab }: {
  onOpenFile: () => void;
  onCloseTab: (index: number) => void;
}) {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const activateTab = useAppStore((s) => s.activateTab);
  const reorderTab = useAppStore((s) => s.reorderTab);

  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 6 },
  }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = openTabs.findIndex((t) => t.path === active.id);
    const to = openTabs.findIndex((t) => t.path === over.id);
    if (from !== -1 && to !== -1) reorderTab(from, to);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        borderBottom: "1px solid var(--line2)",
        background: "var(--bg1)",
        overflowX: "auto",
        scrollbarWidth: "none",
        flexShrink: 0,
      }}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={openTabs.map((t) => t.path)} strategy={horizontalListSortingStrategy}>
          {openTabs.map((tab, i) => (
            <TabPill
              key={tab.path}
              id={tab.path}
              label={tab.name}
              active={i === activeTabIndex}
              onActivate={() => activateTab(i)}
              onClose={() => onCloseTab(i)}
            />
          ))}
        </SortableContext>
      </DndContext>

      <button
        onClick={onOpenFile}
        title="Open file in new tab (Ctrl+T)"
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--fg2)", fontSize: 18, lineHeight: 1,
          padding: "0 6px", borderRadius: 4, flexShrink: 0,
        }}
        aria-label="Open new tab"
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add external OS file drop support**

In `TabBar`, add drag-over and drop handlers to the outer wrapper `<div>` so users can drop a PDF from Explorer onto the tab bar:

```tsx
// Add these props to the outer wrapper div in TabBar:
onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
onDrop={(e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith(".pdf")) {
    // Tauri drag-drop provides the OS path via dataTransfer.getData
    // Fallback: use file.name (path not available in web context without Tauri drag plugin)
    // For now use the file.path if available (Tauri sets it), else skip
    const path = (file as File & { path?: string }).path ?? "";
    if (path) {
      const name = path.split(/[\\/]/).pop() ?? file.name;
      onOpenExternalFile(path, name);
    }
  }
}}
```

Update `TabBar` props to accept `onOpenExternalFile`:
```tsx
export function TabBar({ onOpenFile, onCloseTab, onOpenExternalFile }: {
  onOpenFile: () => void;
  onCloseTab: (index: number) => void;
  onOpenExternalFile: (path: string, name: string) => void;
}) {
```

In `ViewerShell`, pass the callback:
```tsx
<TabBar
  onOpenFile={handleOpenFile}
  onCloseTab={handleCloseTab}
  onOpenExternalFile={(path, name) => openTab({ path, name })}
/>
```

- [ ] **Step 3: TypeScript check**

```
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/viewer/TabBar.tsx
git commit -m "feat(tabs): add TabBar component with dnd-kit reorder and OS file drop"
```

---

### Task 6: Create ViewerShell.tsx

**Files:**
- Create: `src/viewer/ViewerShell.tsx`

Loads the tab session from SQLite on mount, renders the absolute-stacked Viewer instances, handles keyboard shortcuts and the dirty-close guard.

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore, TabEntry } from "../store/useAppStore";
import { TabBar } from "./TabBar";
import Viewer from "./Viewer";
import { ErrorBoundary } from "react-error-boundary";
import { ViewerErrorFallback } from "../components/ErrorFallback";

export default function ViewerShell() {
  const navigate = useNavigate();
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabIndex = useAppStore((s) => s.activeTabIndex);
  const openTab = useAppStore((s) => s.openTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const activateTab = useAppStore((s) => s.activateTab);
  const tabDirty = useAppStore((s) => s.tabDirty);
  const sessionSavedRef = useRef(false);

  // Load persisted session on first mount
  useEffect(() => {
    if (openTabs.length > 0) return; // already populated (navigated back from Home)
    invoke<[TabEntry[], number]>("get_tab_session").then(([tabs, active]) => {
      if (tabs.length === 0) { navigate("/"); return; }
      tabs.forEach((t) => openTab(t));
      activateTab(active);
    }).catch(() => navigate("/"));
  }, []);

  // Persist session whenever tabs change
  useEffect(() => {
    if (openTabs.length === 0) return;
    invoke("save_tab_session", {
      tabs: openTabs.map((t) => ({ path: t.path, name: t.name })),
      activeIndex: activeTabIndex,
    }).catch(console.error);
  }, [openTabs, activeTabIndex]);

  // Persist session on page unload
  useEffect(() => {
    const handler = () => {
      if (openTabs.length === 0) return;
      invoke("save_tab_session", {
        tabs: openTabs.map((t) => ({ path: t.path, name: t.name })),
        activeIndex: activeTabIndex,
      });
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [openTabs, activeTabIndex]);

  const handleOpenFile = useCallback(async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected[0];
    if (!path) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    openTab({ path, name });
  }, [openTab]);

  const handleCloseTab = useCallback((index: number) => {
    const tab = openTabs[index];
    if (tab && tabDirty[tab.path]) {
      if (!confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
    }
    closeTab(index);
    if (openTabs.length <= 1) {
      invoke("clear_tab_session").catch(console.error);
      navigate("/");
    }
  }, [openTabs, tabDirty, closeTab, navigate]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        handleOpenFile();
      } else if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabIndex >= 0) handleCloseTab(activeTabIndex);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (openTabs.length > 1) {
          const next = e.shiftKey
            ? (activeTabIndex - 1 + openTabs.length) % openTabs.length
            : (activeTabIndex + 1) % openTabs.length;
          activateTab(next);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabIndex, openTabs.length, handleOpenFile, handleCloseTab, activateTab]);

  if (openTabs.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <TabBar onOpenFile={handleOpenFile} onCloseTab={handleCloseTab} />
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        {openTabs.map((tab, i) => (
          <div
            key={tab.path}
            style={{
              position: "absolute",
              inset: 0,
              visibility: i === activeTabIndex ? "visible" : "hidden",
              pointerEvents: i === activeTabIndex ? "auto" : "none",
            }}
          >
            <ErrorBoundary FallbackComponent={ViewerErrorFallback} key={tab.path}>
              <Viewer tabPath={tab.path} />
            </ErrorBoundary>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/viewer/ViewerShell.tsx
git commit -m "feat(tabs): add ViewerShell with CSS-stack, keyboard shortcuts, session sync"
```

---

### Task 7: Modify Viewer.tsx — add tabPath prop and per-tab store reads

**Files:**
- Modify: `src/viewer/Viewer.tsx`

Viewer currently reads `viewerFile, setViewerFile, undoViewerFile, setUndoViewerFile, originalViewerPath, setOriginalViewerPath, isViewerDirty, setIsViewerDirty` from the store. We change each to use `tabPath`-keyed reads. The local variable names stay the same so the rest of the 1300-line file changes minimally.

- [ ] **Step 1: Add tabPath prop to the function signature**

Find:
```typescript
export default function Viewer() {
```
Replace with:
```typescript
export default function Viewer({ tabPath }: { tabPath: string }) {
```

- [ ] **Step 2: Replace the store destructure block**

Find (lines ~57–62):
```typescript
  const {
    viewerFile, setViewerFile,
    undoViewerFile, setUndoViewerFile,
    originalViewerPath, setOriginalViewerPath,
    isViewerDirty, setIsViewerDirty,
  } = useAppStore();
```

Replace with:
```typescript
  const viewerFile = useAppStore((s) => {
    const file = s.tabFiles[tabPath];
    const tab = s.openTabs.find((t) => t.path === tabPath);
    return file ?? tab ?? null;
  });
  const isViewerDirty = useAppStore((s) => s.tabDirty[tabPath] ?? false);
  const undoViewerFile = useAppStore((s) => s.tabUndo[tabPath] ?? null);
  const originalViewerPath = useAppStore((s) => s.tabOriginal[tabPath] ?? tabPath);
  const setTabFile = useAppStore((s) => s.setTabFile);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);

  // Local aliases so the rest of the file compiles unchanged
  const setViewerFile = (file: LoadedFile | null) => { if (file) setTabFile(tabPath, file); };
  const setIsViewerDirty = (v: boolean) => setTabDirty(tabPath, v);
  const setUndoViewerFile = (file: LoadedFile | null) => setTabUndo(tabPath, file);
  const setOriginalViewerPath = (p: string | null) => { if (p) setTabOriginal(tabPath, p); };
```

- [ ] **Step 3: Add SQLite page+zoom restore on mount**

After the existing `useEffect` that loads PDF info (search for the first `useEffect` in Viewer that calls `invoke("get_pdf_info"...)`), add a new effect:

```typescript
  // Restore page + zoom from SQLite on tab open
  useEffect(() => {
    invoke<[number, number]>("get_tab_ui_state", { path: tabPath }).then(([page, z]) => {
      if (page > 1) setCurrentPage(page);
      if (z !== 1.0) setZoom(z);
    }).catch(() => {});
  }, [tabPath]);
```

- [ ] **Step 4: Add debounced SQLite write on page/zoom change**

After the restore effect, add:

```typescript
  const uiStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
    uiStateTimerRef.current = setTimeout(() => {
      invoke("save_tab_ui_state", {
        path: tabPath,
        currentPage,
        zoom,
      }).catch(() => {});
    }, 800);
    return () => {
      if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
    };
  }, [tabPath, currentPage, zoom]);
```

- [ ] **Step 5: TypeScript check**

```
npx tsc --noEmit
```

Fix any remaining type errors. Common ones: `invoke<[number, number]>` may need `invoke<[number, number]>` → check that Rust returns a tuple (it does — `(i32, f64)`).

- [ ] **Step 6: Commit**

```bash
git add src/viewer/Viewer.tsx
git commit -m "feat(tabs): add tabPath prop to Viewer, per-tab store reads, SQLite page/zoom sync"
```

---

### Task 8: Update App.tsx to route /view → ViewerShell

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace the import and route**

Find:
```typescript
import Viewer from "./viewer/Viewer";
```
Replace with:
```typescript
import ViewerShell from "./viewer/ViewerShell";
```

Find:
```tsx
        <Route path="/view" element={
          <ErrorBoundary FallbackComponent={ViewerErrorFallback} key="viewer">
            <Viewer />
          </ErrorBoundary>
        } />
```
Replace with:
```tsx
        <Route path="/view" element={<ViewerShell />} />
```

`ViewerShell` already wraps each `Viewer` in its own `ErrorBoundary` — no need to double-wrap here.

- [ ] **Step 2: TypeScript check + build**

```
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(tabs): route /view to ViewerShell"
```

---

### Task 9: Update useOpenWithFile.ts

**Files:**
- Modify: `src/hooks/useOpenWithFile.ts`

When the viewer already has tabs open, opening a file from "Open with" / double-click should open a new tab rather than replacing the current one.

- [ ] **Step 1: Replace the file**

```typescript
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";

export function useOpenWithFile() {
  const navigate = useNavigate();
  const openTab = useAppStore((s) => s.openTab);
  const openTabs = useAppStore((s) => s.openTabs);
  const setTabOriginal = useAppStore((s) => s.setTabOriginal);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setTabUndo = useAppStore((s) => s.setTabUndo);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    listen<string>("open-pdf", (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() ?? path;
      openTab({ path, name });
      setTabOriginal(path, path);
      setTabDirty(path, false);
      setTabUndo(path, null);
      navigate("/view");
    }).then((fn) => { cleanup = fn; });

    return () => { cleanup?.(); };
  }, []);
}
```

- [ ] **Step 2: TypeScript check**

```
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useOpenWithFile.ts
git commit -m "feat(tabs): useOpenWithFile opens new tab instead of replacing viewer"
```

---

### Task 10: Also update Home.tsx file-open flow

**Files:**
- Modify: `src/tools/Home.tsx`

When the user opens a file from the Home screen and the viewer already has open tabs, it should open as a new tab.

- [ ] **Step 1: Find the file-open handler in Home.tsx**

Search for where `setViewerFile` is called in `src/tools/Home.tsx`. It will look like:
```typescript
setViewerFile({ path, name });
setOriginalViewerPath(path);
setIsViewerDirty(false);
setUndoViewerFile(null);
navigate("/view");
```

- [ ] **Step 2: Replace the handler**

Replace all instances of the pattern above with:
```typescript
openTab({ path, name });
setTabOriginal(path, path);
setTabDirty(path, false);
setTabUndo(path, null);
navigate("/view");
```

Make sure to import `openTab, setTabOriginal, setTabDirty, setTabUndo` from `useAppStore` and remove the old imports of `setViewerFile, setOriginalViewerPath, setIsViewerDirty, setUndoViewerFile`.

- [ ] **Step 3: TypeScript check**

```
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/Home.tsx
git commit -m "feat(tabs): Home opens files as tabs when viewer is active"
```

---

### Task 11: Smoke tests

Run the app (`npm run tauri dev` in VS Developer PowerShell) and verify:

- [ ] Open a PDF from Home → viewer opens with tab bar showing 1 tab
- [ ] Press Ctrl+T → file picker opens → second PDF opens as tab 2
- [ ] Switch between tabs → each tab remembers its own page position
- [ ] Drag a PDF file onto the tab bar → opens as new tab
- [ ] Drag a tab pill to reorder → tabs reorder correctly
- [ ] Click × on a tab → tab closes, adjacent tab activates
- [ ] Ctrl+W closes active tab
- [ ] Ctrl+Tab cycles tabs forward, Ctrl+Shift+Tab cycles back
- [ ] Close app with 2 tabs open on page 5 each → reopen → both tabs restore to page 5
- [ ] Navigate to Home from viewer → go back to viewer → all tabs still open
- [ ] Make a change (dirty) → Ctrl+W → confirm dialog appears
- [ ] Click + button → file picker opens → file opens as new tab
