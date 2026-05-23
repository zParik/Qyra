# Multiple Tabs — Design Spec

**Date:** 2026-05-23  
**Status:** Approved  
**Priority:** v1.2 — highest-impact pending feature

---

## Overview

Replace `viewerFile: LoadedFile | null` (single open file) with a multi-tab viewer. All tabs stay mounted in the DOM for full in-session state restore. SQLite persists the tab list and per-file UI state (page, zoom) across restarts.

---

## Goals

- Open multiple PDFs simultaneously in the viewer without losing state when switching
- Full state restore on tab switch: page position, active tool, redact regions, signatures, form fills all survive
- Cross-session restore: reopening the app restores which tabs were open and their page positions
- Four ways to open a file into a new tab: Ctrl+T, drag onto tab bar, Home→Viewer, + button
- Keyboard tab management: Ctrl+W (close), Ctrl+Tab / Ctrl+Shift+Tab (cycle)
- Tab bar: filename labels, close button, drag-to-reorder
- Tab list persists through Home navigation and returns intact

---

## Non-Goals

- Syncing tab state to cloud
- Tab groups or split-view (two PDFs side-by-side)
- Duplicating a tab

---

## Architecture

### 1. Store changes (`useAppStore`)

Remove:
```typescript
viewerFile: LoadedFile | null
```

Add:
```typescript
openTabs: TabEntry[]      // ordered list of open tabs
activeTabIndex: number    // -1 when no tabs open
```

`TabEntry` shape (same as `LoadedFile`):
```typescript
interface TabEntry {
  path: string
  name: string
  info?: PdfInfo
  thumbnail?: string  // base64 page-1 thumbnail
}
```

**Backward compat:** Expose `viewerFile` as a derived selector:
```typescript
const viewerFile = openTabs[activeTabIndex] ?? null
```
All existing consumers of `viewerFile` (Viewer.tsx, useAutoSave, etc.) continue working without change.

Per-tab dirty/undo state moves to `Record<path, ...>` maps:
```typescript
undoByPath: Record<string, LoadedFile>
dirtyByPath: Record<string, boolean>
originalPathByPath: Record<string, string>
```
Selectors: `isViewerDirty` → `dirtyByPath[openTabs[activeTabIndex]?.path] ?? false`, etc.

New actions:
```typescript
openTab(entry: TabEntry): void          // add + activate
closeTab(index: number): void           // remove, adjust activeTabIndex
activateTab(index: number): void
reorderTab(from: number, to: number): void
```

---

### 2. DOM layout

New component `ViewerShell` at route `/view`:

```
<ViewerShell>
  <TabBar />
  <div class="tab-stack" style="position:relative; flex:1">
    {openTabs.map((tab, i) => (
      <div key={tab.path}
           style={{
             position: 'absolute', inset: 0,
             visibility: i === activeTabIndex ? 'visible' : 'hidden',
             pointerEvents: i === activeTabIndex ? 'auto' : 'none',
           }}>
        <Viewer tabPath={tab.path} />
      </div>
    ))}
  </div>
</ViewerShell>
```

`visibility: hidden` (not `display: none`) preserves element dimensions so the virtual-scroll engine inside Viewer can measure its container correctly.

`key={tab.path}` — React keeps each Viewer instance alive as long as its path is in `openTabs`.

---

### 3. Viewer changes

`Viewer` receives one new prop: `tabPath: string`. Used only for SQLite reads/writes. All internal hook state (signatures, redact regions, form fills, tool mode, etc.) remains unchanged.

On mount: read `tab_ui_state` for `tabPath` → set `currentPage` and `zoom`.  
On page change / zoom change: debounced write to `tab_ui_state` via `save_tab_ui_state` Tauri command.

No other changes inside Viewer.

---

### 4. SQLite schema

Two new tables, initialized on app startup via a `setup_tab_db` Rust command (called once from `App.tsx`):

```sql
-- Which files are open (session restore)
CREATE TABLE IF NOT EXISTS open_tabs (
  position  INTEGER NOT NULL,
  path      TEXT    NOT NULL UNIQUE,
  name      TEXT    NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);

-- Per-file UI state (survives restarts, useful even in single-file mode)
CREATE TABLE IF NOT EXISTS tab_ui_state (
  path         TEXT    PRIMARY KEY,
  current_page INTEGER NOT NULL DEFAULT 1,
  zoom         REAL    NOT NULL DEFAULT 1.0,
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**Why separate tables:**  
`open_tabs` represents a session (mutable, cleared on deliberate close).  
`tab_ui_state` is per-file and accumulates over time — useful even when a file is not currently in a tab (e.g., "last read page" for recently reopened files).

---

### 5. Rust commands

| Command | Args | Returns | When called |
|---|---|---|---|
| `setup_tab_db` | — | `()` | App startup (once) |
| `get_tab_session` | — | `Vec<TabEntry>` | ViewerShell mount |
| `save_tab_session` | `tabs: Vec<TabEntry>, active: i32` | `()` | Tab switch, app close |
| `save_tab_ui_state` | `path: String, page: i32, zoom: f64` | `()` | Debounced on scroll/zoom |
| `clear_tab_session` | — | `()` | Explicit "close all" |

File: `src-tauri/src/commands/tabs.rs` (new file).  
Registered in `lib.rs` alongside existing commands.

---

### 6. TabBar component

File: `src/viewer/TabBar.tsx`

- Pill per open tab: `[filename] [×]`
- Active tab highlighted via CSS variable (`--accent`)
- `+` button at far right → opens system file picker (same as existing `open_dialog`)
- Drag-to-reorder via `@dnd-kit/sortable` (already in project for `ReorderPanel`)
- Overflow: horizontal scroll with fade mask when tabs don't fit

---

### 7. Open-file flows

| Trigger | Mechanism |
|---|---|
| **Ctrl+T** | Global keydown in `ViewerShell` → file picker → `openTab()` |
| **Drag onto tab bar** | `onDrop` on `TabBar` → read path → `openTab()` |
| **Home → Viewer** | `useOpenWithFile` checks `openTabs.length > 0`; if true, `openTab()` instead of `setViewerFile()` |
| **+ button** | Same as Ctrl+T |

---

### 8. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+T | Open file picker → new tab |
| Ctrl+W | Close active tab (prompts if dirty) |
| Ctrl+Tab | Cycle to next tab |
| Ctrl+Shift+Tab | Cycle to previous tab |

Implemented in `ViewerShell` via `useEffect` + `window.addEventListener('keydown', ...)`.

---

### 9. Back-to-Home behaviour

`openTabs` lives in Zustand (in-memory) and SQLite. Navigating to `/` does NOT clear `openTabs`. Returning to `/view` remounts `ViewerShell` — CSS-hidden Viewers are remounted from scratch, but `tab_ui_state` SQLite restore gives instant page positioning.

---

### 10. Dirty-tab close guard

`closeTab(index)`: if `dirtyByPath[tab.path]` is true, show confirmation dialog ("Unsaved changes — close anyway?"). Matches existing single-file back-confirm behavior in Viewer.

---

## File map

| File | Change |
|---|---|
| `src/store/useAppStore.ts` | Replace `viewerFile` with `openTabs + activeTabIndex`, add per-path maps |
| `src/viewer/ViewerShell.tsx` | **New** — tab stack container + keyboard shortcuts |
| `src/viewer/TabBar.tsx` | **New** — tab pill UI + dnd-kit reorder |
| `src/viewer/Viewer.tsx` | Add `tabPath` prop; read/write `tab_ui_state` on mount/scroll/zoom |
| `src/App.tsx` | Route `/view` → `<ViewerShell>` instead of `<Viewer>` |
| `src/hooks/useOpenWithFile.ts` | Check `openTabs.length` to decide new-tab vs replace |
| `src-tauri/src/commands/tabs.rs` | **New** — 5 SQLite commands |
| `src-tauri/src/lib.rs` | Register new commands |

---

## Testing checklist (smoke test, no automated tests)

- [ ] Open 2 PDFs: switch between tabs, verify page position restores
- [ ] Edit redact regions on tab 1, switch to tab 2, switch back — regions survive
- [ ] Close app with 2 tabs open, reopen — tabs restore to last page
- [ ] Ctrl+W on dirty tab shows confirm dialog
- [ ] Ctrl+Tab cycles tabs
- [ ] Drag PDF onto tab bar opens it
- [ ] Drag tab pills reorders them
- [ ] Home → open file when viewer has tabs → opens as new tab
- [ ] + button opens file picker
