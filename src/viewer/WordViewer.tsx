import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getWordHtml, saveWordDocument, replaceInWord,
  type RunEdit, type BlockEdit, type ParaEdit, type RowEdit, type CellEdit, type CellBorder,
} from "../lib/tauri";
import { UI } from "../lib/tokens";

function rgbToHex(rgb: string): string | undefined {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return undefined;
  const hex = (n: string) => parseInt(n, 10).toString(16).padStart(2, "0");
  return (hex(m[1]!) + hex(m[2]!) + hex(m[3]!)).toUpperCase();
}

function pxToPt(px: string): number | undefined {
  const v = parseFloat(px);
  return Number.isNaN(v) ? undefined : Math.round((v / 1.333) * 10) / 10;
}

function mapAlign(ta: string): string {
  if (ta === "center") return "center";
  if (ta === "right" || ta === "end") return "right";
  if (ta === "justify") return "justify";
  return "left";
}

/**
 * Serialize the editor surface into the ordered block list the save path wants.
 * Untouched blocks (innerHTML matches their snapshot) become `verbatim` so the
 * backend re-emits their exact source bytes; changed / new paragraphs carry their
 * runs; touched tables are walked into rows/cells (untouched cells stay verbatim).
 */
function collectBlocks(root: HTMLElement, orig: Record<number, string>, cellOrig: Record<string, string>): BlockEdit[] {
  const out: BlockEdit[] = [];
  for (const el of Array.from(root.children) as HTMLElement[]) {
    const tag = el.tagName.toLowerCase();
    const dbAttr = el.getAttribute("data-block");
    const origIdx = dbAttr == null ? null : parseInt(dbAttr, 10);

    if (tag === "table") {
      if (origIdx != null && el.innerHTML === orig[origIdx]) {
        out.push({ kind: "verbatim", orig: origIdx });
      } else {
        out.push(collectTable(el as HTMLTableElement, origIdx, cellOrig));
      }
      continue;
    }
    if (tag === "hr") continue; // stray page-break rule pulled out of a paragraph
    if (tag !== "p") {
      // Unknown top-level node (e.g. a div from a paste) → treat as a paragraph.
      const runs = collectRuns(el);
      if (runs.length) out.push({ kind: "para", orig: null, runs, align: mapAlign(getComputedStyle(el).textAlign) });
      continue;
    }
    if (origIdx != null && el.innerHTML === orig[origIdx]) {
      out.push({ kind: "verbatim", orig: origIdx });
    } else {
      out.push({ kind: "para", orig: origIdx, runs: collectRuns(el), align: mapAlign(getComputedStyle(el).textAlign) });
    }
  }
  return out;
}

/** The `<tr>`s of a table, whether or not the browser inserted a `<tbody>`. */
function tableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>(":scope > tr, :scope > tbody > tr"));
}

/**
 * Walk an edited table into the backend's row/cell model. Builds an occupancy
 * grid from HTML colspan/rowspan, then emits one `<w:tc>` per grid column run:
 * a colspan → `gridSpan`, a rowspan → a `vMerge` restart cell plus `continue`
 * placeholder cells in the rows it covers. Untouched single cells stay verbatim.
 */
function collectTable(table: HTMLTableElement, blockIdx: number | null, cellOrig: Record<string, string>): BlockEdit {
  const trs = tableRows(table);
  type Origin = { td: HTMLTableCellElement; colspan: number; rowspan: number };
  const origin: (Origin | null)[][] = [];
  const covered: boolean[][] = [];
  const ensure = (r: number) => { while (origin.length <= r) { origin.push([]); covered.push([]); } };

  for (let r = 0; r < trs.length; r++) {
    ensure(r);
    const tds = Array.from(trs[r]!.children).filter((c) => c.tagName.toLowerCase() === "td") as HTMLTableCellElement[];
    let c = 0;
    for (const td of tds) {
      while (covered[r]![c]) c++;
      const colspan = Math.max(1, td.colSpan || 1);
      const rowspan = Math.max(1, td.rowSpan || 1);
      ensure(r + rowspan - 1);
      origin[r]![c] = { td, colspan, rowspan };
      for (let rr = r; rr < r + rowspan; rr++) { ensure(rr); for (let cc = c; cc < c + colspan; cc++) covered[rr]![cc] = true; }
      c += colspan;
    }
  }
  const ncol = Math.max(1, ...covered.map((row) => row.length));

  const rows: RowEdit[] = [];
  for (let r = 0; r < trs.length; r++) {
    const cells: CellEdit[] = [];
    let c = 0;
    while (c < ncol) {
      const og = origin[r]![c];
      if (og) {
        cells.push(makeCellEdit(og.td, blockIdx, cellOrig, og.colspan, og.rowspan > 1 ? "restart" : null));
        c += og.colspan;
      } else if (covered[r]![c]) {
        // Vertical continuation of a cell that started in an earlier row.
        let or_ = r; while (or_ >= 0 && !origin[or_]![c]) or_--;
        const colspan = or_ >= 0 ? origin[or_]![c]!.colspan : 1;
        cells.push({ kind: "cell", orig_row: null, orig_col: null, grid_span: colspan > 1 ? colspan : null, v_merge: "continue", shd: null, border: null, blocks: [] });
        c += colspan;
      } else {
        // Ragged row shortfall — pad with an empty new cell.
        cells.push({ kind: "cell", orig_row: null, orig_col: null, grid_span: null, v_merge: null, shd: null, border: null, blocks: [{ runs: [], align: null }] });
        c += 1;
      }
    }
    rows.push({ orig_row: rowOrig(trs[r]!), cells });
  }
  return { kind: "table", orig: blockIdx, cols: ncol, rows };
}

/** Original row index for a `<tr>` (from the first mapped cell), or null if new. */
function rowOrig(tr: HTMLTableRowElement): number | null {
  for (const td of Array.from(tr.children) as HTMLElement[]) {
    const r = td.getAttribute("data-r");
    if (r != null) return parseInt(r, 10);
  }
  return null;
}

function cellShd(td: HTMLElement): string | null {
  return td.dataset.shd || null;
}

function cellBorder(td: HTMLElement): CellBorder | null {
  const b = td.dataset.border;
  if (!b) return null;
  if (b === "nil") return { style: "nil" };
  const [style, color, sz] = b.split(":");
  return { style: style === "nil" ? "nil" : "single", color: color || null, sz: sz ? parseInt(sz, 10) : null };
}

/** Build a cell edit: verbatim when a mapped single cell is untouched, else a
 *  rebuilt cell carrying its span/merge/shading/border + paragraph content. */
function makeCellEdit(
  td: HTMLTableCellElement, blockIdx: number | null, cellOrig: Record<string, string>,
  colspan: number, vMerge: "restart" | null,
): CellEdit {
  const rAttr = td.getAttribute("data-r");
  const cAttr = td.getAttribute("data-c");
  const origRow = rAttr == null ? null : parseInt(rAttr, 10);
  const origCol = cAttr == null ? null : parseInt(cAttr, 10);
  const shd = cellShd(td);
  const border = cellBorder(td);
  const edited = td.dataset.edited === "1";
  const key = blockIdx != null && origRow != null && origCol != null ? `${blockIdx}:${origRow}:${origCol}` : null;

  if (!edited && origRow != null && origCol != null && colspan === 1 && vMerge == null && !shd && !border && key != null && td.innerHTML === cellOrig[key]) {
    return { kind: "verbatim", orig_row: origRow, orig_col: origCol };
  }
  return {
    kind: "cell",
    orig_row: origRow, orig_col: origCol,
    grid_span: colspan > 1 ? colspan : null,
    v_merge: vMerge,
    shd, border,
    blocks: collectCellParas(td),
  };
}

/** A cell's paragraphs; a cell with only loose text becomes one paragraph. */
function collectCellParas(td: HTMLElement): ParaEdit[] {
  const ps = Array.from(td.querySelectorAll<HTMLElement>(":scope > p"));
  if (ps.length === 0) {
    return [{ runs: collectRuns(td), align: mapAlign(getComputedStyle(td).textAlign) }];
  }
  return ps.map((p) => ({ runs: collectRuns(p), align: mapAlign(getComputedStyle(p).textAlign) }));
}

/** Serialize a paragraph element's text into formatting-grouped runs. */
function collectRuns(p: HTMLElement): RunEdit[] {
  const runs: RunEdit[] = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest(".qyra-marker") || parent.closest(".qyra-tab")) continue;
    const text = node.textContent || "";
    if (!text) continue;
    const cs = getComputedStyle(parent);
    const bold = cs.fontWeight === "bold" || parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const underline = (cs.textDecorationLine || cs.textDecoration || "").includes("underline");
    const color = rgbToHex(cs.color);
    const size_pt = pxToPt(cs.fontSize);
    const last = runs[runs.length - 1];
    if (last && !!last.bold === bold && !!last.italic === italic && !!last.underline === underline && last.color === color && last.size_pt === size_pt) {
      last.text += text;
    } else {
      runs.push({ text, bold, italic, underline, color, size_pt });
    }
  }
  return runs;
}

/**
 * Single-surface .docx editor: opening a document drops you straight into an
 * editable, formatted page (no separate view/edit modes). Type like a word
 * processor; edits save back through the lossless engine.
 */
export default function WordViewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = (location.state as { path?: string; name?: string } | null) ?? null;

  const [path, setPath] = useState<string | null>(initial?.path ?? null);
  const [name, setName] = useState<string | null>(initial?.name ?? null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [inTable, setInTable] = useState(false);

  const editRef = useRef<HTMLDivElement>(null);
  const origHtmlRef = useRef<Record<number, string>>({});
  const origCellRef = useRef<Record<string, string>>({}); // "blockIdx:r:c" -> cell innerHTML
  const undoRef = useRef<string[]>([]);                    // structural-edit snapshots

  // Load (and reload after a save) the document as editable HTML.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setError(null);
    setStatus(null);
    setHtml(null);
    (async () => {
      try {
        const h = await getWordHtml(path);
        if (!cancelled) setHtml(h);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [path, version]);

  // Inject into the editable surface + snapshot originals for change detection.
  useEffect(() => {
    if (html == null || !editRef.current) return;
    editRef.current.innerHTML = html;
    const map: Record<number, string> = {};
    const cellMap: Record<string, string> = {};
    editRef.current.querySelectorAll<HTMLElement>(":scope > [data-block]").forEach((n) => {
      const i = parseInt(n.getAttribute("data-block") || "-1", 10);
      if (i < 0) return;
      map[i] = n.innerHTML;
      if (n.tagName.toLowerCase() === "table") {
        n.querySelectorAll<HTMLElement>("td[data-r][data-c]").forEach((td) => {
          cellMap[`${i}:${td.getAttribute("data-r")}:${td.getAttribute("data-c")}`] = td.innerHTML;
        });
      }
    });
    origHtmlRef.current = map;
    origCellRef.current = cellMap;
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* ignore */ }
  }, [html]);

  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editRef.current?.focus();
  }

  // Track whether the caret sits inside a table so the table tools can enable.
  useEffect(() => {
    const onSel = () => setInTable(caretCell() != null);
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  /** The `<td>` containing the caret, if inside the editor. */
  function caretCell(): HTMLTableCellElement | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node: Node | null = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const el = node as HTMLElement | null;
    if (!el || !editRef.current || !editRef.current.contains(el)) return null;
    return el.closest("td");
  }

  function newTd(): HTMLTableCellElement {
    const td = document.createElement("td");
    td.setAttribute("style", "border:1px solid #aaa;padding:4px;vertical-align:top");
    td.innerHTML = "<p><br></p>"; // no data-r/data-c → a fresh cell
    return td;
  }

  function pushUndo() {
    if (editRef.current) undoRef.current.push(editRef.current.innerHTML);
  }
  function undoTable() {
    const snap = undoRef.current.pop();
    if (snap != null && editRef.current) {
      editRef.current.innerHTML = snap;
      editRef.current.focus();
    }
  }

  // ---- Wave C: rows & columns ----
  function insertRow(below: boolean) {
    const td = caretCell();
    const tr = td?.closest("tr");
    if (!td || !tr) return;
    pushUndo();
    const count = Array.from(tr.children).filter((c) => c.tagName.toLowerCase() === "td").length;
    const newTr = document.createElement("tr");
    for (let i = 0; i < count; i++) newTr.appendChild(newTd());
    tr.parentNode!.insertBefore(newTr, below ? tr.nextSibling : tr);
    editRef.current?.focus();
  }
  function deleteRow() {
    const td = caretCell();
    const tr = td?.closest("tr");
    const table = td?.closest("table");
    if (!td || !tr || !table) return;
    pushUndo();
    if (tableRows(table as HTMLTableElement).length <= 1) table.remove();
    else tr.remove();
    editRef.current?.focus();
  }
  function insertCol(right: boolean) {
    const td = caretCell();
    const tr = td?.closest("tr");
    const table = td?.closest("table");
    if (!td || !tr || !table) return;
    const idx = Array.from(tr.children).indexOf(td);
    pushUndo();
    for (const row of tableRows(table as HTMLTableElement)) {
      const ref = row.children[idx] as HTMLElement | undefined;
      const cell = newTd();
      row.insertBefore(cell, right ? (ref ? ref.nextSibling : null) : ref ?? null);
    }
    editRef.current?.focus();
  }
  function deleteCol() {
    const td = caretCell();
    const tr = td?.closest("tr");
    const table = td?.closest("table");
    if (!td || !tr || !table) return;
    const idx = Array.from(tr.children).indexOf(td);
    pushUndo();
    for (const row of tableRows(table as HTMLTableElement)) (row.children[idx] as HTMLElement | undefined)?.remove();
    if (tableRows(table as HTMLTableElement).every((r) => r.children.length === 0)) table.remove();
    editRef.current?.focus();
  }

  // ---- Wave D: merge & split ----
  function mergeRight() {
    const td = caretCell();
    const next = td?.nextElementSibling as HTMLTableCellElement | null;
    if (!td || !next || next.tagName.toLowerCase() !== "td") return;
    pushUndo();
    td.colSpan = (td.colSpan || 1) + (next.colSpan || 1);
    td.dataset.edited = "1";
    while (next.firstChild) td.appendChild(next.firstChild);
    next.remove();
    editRef.current?.focus();
  }
  function mergeDown() {
    const td = caretCell();
    const tr = td?.closest("tr");
    const table = td?.closest("table");
    if (!td || !tr || !table) return;
    const rows = tableRows(table as HTMLTableElement);
    const ri = rows.indexOf(tr as HTMLTableRowElement);
    const idx = Array.from(tr.children).indexOf(td);
    const below = rows[ri + 1];
    const belowTd = below?.children[idx] as HTMLTableCellElement | undefined;
    if (!belowTd) return;
    pushUndo();
    td.rowSpan = (td.rowSpan || 1) + (belowTd.rowSpan || 1);
    td.dataset.edited = "1";
    while (belowTd.firstChild) td.appendChild(belowTd.firstChild);
    belowTd.remove();
    editRef.current?.focus();
  }
  function splitCell() {
    const td = caretCell();
    if (!td) return;
    pushUndo();
    td.colSpan = 1;
    td.rowSpan = 1;
    td.dataset.edited = "1";
    editRef.current?.focus();
  }

  // ---- Wave E: shading & borders ----
  function shadeCell(color: string | null) {
    const td = caretCell();
    if (!td) return;
    pushUndo();
    td.dataset.edited = "1";
    if (color) {
      td.style.backgroundColor = "#" + color;
      td.dataset.shd = color;
    } else {
      td.style.backgroundColor = "";
      delete td.dataset.shd;
    }
    editRef.current?.focus();
  }
  function borderCell(on: boolean) {
    const td = caretCell();
    if (!td) return;
    pushUndo();
    td.dataset.edited = "1";
    if (on) {
      td.style.border = "1px solid #000";
      td.dataset.border = "single:000000:8";
    } else {
      td.style.border = "none";
      td.dataset.border = "nil";
    }
    editRef.current?.focus();
  }

  /** Insert a fresh 2×2 table after the caret's top-level block (or at the end). */
  function insertTable() {
    if (!editRef.current) return;
    pushUndo();
    const tbl = document.createElement("table");
    tbl.className = "qyra-table";
    tbl.setAttribute("style", "border-collapse:collapse");
    for (let r = 0; r < 2; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < 2; c++) tr.appendChild(newTd());
      tbl.appendChild(tr);
    }
    // Find the caret's top-level block to insert after; else append.
    let node = window.getSelection()?.anchorNode as Node | null;
    while (node && node.parentElement !== editRef.current) node = node.parentElement;
    const top = node as HTMLElement | null;
    if (top && top.parentElement === editRef.current) top.after(tbl);
    else editRef.current.appendChild(tbl);
    editRef.current.focus();
  }

  async function browse() {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Word Documents", extensions: ["docx"] }] });
      if (!sel) return;
      const p = Array.isArray(sel) ? sel[0]! : sel;
      setName(p.split(/[\\/]/).pop() ?? p);
      setPath(p);
    } catch { /* dismissed */ }
  }

  async function save() {
    if (!path || saving || !editRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const blocks = collectBlocks(editRef.current, origHtmlRef.current, origCellRef.current);
      await saveWordDocument(path, blocks, path);
      setStatus("Saved.");
      setVersion((v) => v + 1); // reload from the saved file
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function doReplace() {
    if (!path || !find || saving) return;
    setSaving(true);
    setError(null);
    try {
      await replaceInWord(path, find, replace, path);
      setStatus(`Replaced “${find}”.`);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const tbtn: React.CSSProperties = {
    width: 30, height: 28, background: "var(--bg1)", border: "1px solid var(--line)",
    borderRadius: 5, color: "var(--fg0)", cursor: "pointer", fontSize: 12.5,
  };
  const inputStyle: React.CSSProperties = {
    background: "var(--bg0)", border: "1px solid var(--line)", borderRadius: 5,
    color: "var(--fg0)", fontSize: 12.5, padding: "4px 8px", width: 120, fontFamily: UI,
  };
  // Auto-width toolbar button (table tools).
  const wbtn: React.CSSProperties = {
    height: 26, padding: "3px 8px", background: "var(--bg1)", border: "1px solid var(--line)",
    borderRadius: 5, color: "var(--fg0)", cursor: "pointer", fontSize: 12,
  };
  const sepStyle: React.CSSProperties = { width: 1, height: 18, background: "var(--line)", margin: "0 4px" };

  return (
    <div className="flex flex-col" style={{ height: "100dvh", background: "var(--bg0)", fontFamily: UI }}>
      <header
        className="flex items-center gap-3 shrink-0"
        style={{ height: 44, padding: "0 14px", borderBottom: "1px solid var(--line2)", color: "var(--fg0)" }}
      >
        <button onClick={() => navigate("/")} style={{ background: "transparent", border: "none", color: "var(--fg1)", cursor: "pointer", fontSize: 13 }}>
          ← Home
        </button>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{name ?? "Word"}</span>
        {status && <span style={{ color: "var(--fg2)", fontSize: 12 }}>{status}</span>}
        <span style={{ flex: 1 }} />
        {path && (
          <button
            onClick={save}
            disabled={saving}
            style={{ ...tbtn, width: "auto", padding: "5px 14px", background: "var(--accent, #3b6ea5)", color: "#fff" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button onClick={browse} style={{ ...tbtn, width: "auto", padding: "5px 12px" }}>Open .docx</button>
      </header>

      {path && (
        <div className="flex items-center gap-1 shrink-0 flex-wrap" style={{ padding: "8px 14px", borderBottom: "1px solid var(--line2)" }}>
          {([["bold", "B"], ["italic", "I"], ["underline", "U"]] as const).map(([cmd, label]) => (
            <button key={cmd} onMouseDown={(e) => { e.preventDefault(); exec(cmd); }} title={cmd}
              style={{ ...tbtn, fontWeight: cmd === "bold" ? 700 : 400, fontStyle: cmd === "italic" ? "italic" : "normal", textDecoration: cmd === "underline" ? "underline" : "none" }}>
              {label}
            </button>
          ))}
          <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
          {([["justifyLeft", "L", "Align left"], ["justifyCenter", "C", "Align center"], ["justifyRight", "R", "Align right"], ["justifyFull", "J", "Justify"]] as const).map(([cmd, label, title]) => (
            <button key={cmd} onMouseDown={(e) => { e.preventDefault(); exec(cmd); }} title={title} style={tbtn}>{label}</button>
          ))}
          <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
          {["000000", "C00000", "2E5BBA", "2E7D32"].map((c) => (
            <button key={c} onMouseDown={(e) => { e.preventDefault(); exec("foreColor", "#" + c); }} title={"Color #" + c}
              style={{ width: 22, height: 22, background: "#" + c, border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer" }} />
          ))}
          <span style={{ flex: 1 }} />
          <input style={inputStyle} placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
          <input style={inputStyle} placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
          <button onClick={doReplace} disabled={!find || saving} style={{ ...tbtn, width: "auto", padding: "5px 10px" }}>Replace all</button>
        </div>
      )}

      {path && (
        <div className="flex items-center gap-1 shrink-0 flex-wrap" style={{ padding: "6px 14px", borderBottom: "1px solid var(--line2)", fontSize: 12 }}>
          <button onMouseDown={(e) => { e.preventDefault(); insertTable(); }} title="Insert a 2×2 table" style={wbtn}>+ Table</button>
          <span style={sepStyle} />
          <span style={{ color: "var(--fg2)", marginRight: 4 }}>Table:</span>
          {([
            ["Row ↑", () => insertRow(false), "Insert row above"],
            ["Row ↓", () => insertRow(true), "Insert row below"],
            ["Row ✕", deleteRow, "Delete row"],
            ["Col ←", () => insertCol(false), "Insert column left"],
            ["Col →", () => insertCol(true), "Insert column right"],
            ["Col ✕", deleteCol, "Delete column"],
            ["Merge →", mergeRight, "Merge with cell to the right"],
            ["Merge ↓", mergeDown, "Merge with cell below"],
            ["Split", splitCell, "Split merged cell"],
          ] as const).map(([label, fn, title]) => (
            <button key={label} disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); fn(); }} title={title} style={wbtn}>{label}</button>
          ))}
          <span style={sepStyle} />
          {["FFFF00", "D9D9D9", "DEEAF6"].map((c) => (
            <button key={c} disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); shadeCell(c); }} title={"Shade #" + c}
              style={{ width: 20, height: 20, background: "#" + c, border: "1px solid var(--line)", borderRadius: 4, cursor: inTable ? "pointer" : "default", opacity: inTable ? 1 : 0.4 }} />
          ))}
          <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); shadeCell(null); }} title="Clear shading" style={wbtn}>Shade ✕</button>
          <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); borderCell(true); }} title="Cell border on" style={wbtn}>▦</button>
          <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); borderCell(false); }} title="Cell border off" style={wbtn}>▢</button>
          <span style={sepStyle} />
          <button onMouseDown={(e) => { e.preventDefault(); undoTable(); }} title="Undo last table change" style={wbtn}>↶ Undo</button>
        </div>
      )}

      <div className="flex-1 overflow-auto" style={{ padding: 24, background: "var(--bg0)" }}>
        {error && <div role="alert" style={{ color: "#e07070", fontSize: 13, marginBottom: 16 }}>{error}</div>}

        {!path && !error && (
          <div style={{ color: "var(--fg2)", fontSize: 14, textAlign: "center", marginTop: 80 }}>
            Open a Word document to start editing.
          </div>
        )}

        {path && (
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            {html == null && !error && (
              <div style={{ color: "var(--fg2)", fontSize: 13, textAlign: "center", padding: 40 }}>Loading…</div>
            )}
            <div
              ref={editRef}
              contentEditable={html != null}
              suppressContentEditableWarning
              spellCheck={false}
              style={{
                background: "#fff",
                color: "#111",
                padding: "56px 64px",
                minHeight: 500,
                boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
                borderRadius: 2,
                outline: "none",
                fontFamily: "Arial, Helvetica, sans-serif",
                lineHeight: 1.3,
                display: html == null ? "none" : "block",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
