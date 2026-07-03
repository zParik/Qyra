import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getWordHtml, getWordMetrics, getWordChrome, saveWordDocument, replaceInWord,
  type RunEdit, type BlockEdit, type ParaEdit, type RowEdit, type CellEdit, type CellBorder,
  type WordPageMetrics, type WordChrome,
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

const PT2PX = 96 / 72; // 1pt = 1/72in, 1px = 1/96in on screen
const DEFAULT_METRICS: WordPageMetrics = {
  widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72,
};

interface PxMetrics { pageW: number; pageH: number; padTop: number; padRight: number; padBottom: number; padLeft: number; contentH: number }
function metricsPx(m: WordPageMetrics): PxMetrics {
  return {
    pageW: m.widthPt * PT2PX,
    pageH: m.heightPt * PT2PX,
    padTop: m.marginTopPt * PT2PX,
    padRight: m.marginRightPt * PT2PX,
    padBottom: m.marginBottomPt * PT2PX,
    padLeft: m.marginLeftPt * PT2PX,
    contentH: Math.max(120, (m.heightPt - m.marginTopPt - m.marginBottomPt) * PT2PX),
  };
}

const isChrome = (el: Element) => el.classList.contains("qyra-header") || el.classList.contains("qyra-footer");

/** Top-level body blocks in document order, whether or not they're wrapped in
 *  `.qyra-page` sheets yet. Page chrome (header/footer) is skipped. */
function topBlocks(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const ch of Array.from(root.children) as HTMLElement[]) {
    if (ch.classList.contains("qyra-page")) {
      for (const c of Array.from(ch.children) as HTMLElement[]) if (!isChrome(c)) out.push(c);
    } else if (!isChrome(ch)) {
      out.push(ch);
    }
  }
  return out;
}

function makePage(px: PxMetrics, chrome?: WordChrome): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "qyra-page";
  d.style.cssText = `position:relative;width:${px.pageW}px;min-height:${px.pageH}px;padding:${px.padTop}px ${px.padRight}px ${px.padBottom}px ${px.padLeft}px`;
  if (chrome?.header) d.appendChild(chromeBox("qyra-header", chrome.header, px, true));
  if (chrome?.footer) d.appendChild(chromeBox("qyra-footer", chrome.footer, px, false));
  return d;
}

/** A non-editable header/footer positioned in the page's top/bottom margin. */
function chromeBox(cls: string, html: string, px: PxMetrics, top: boolean): HTMLDivElement {
  const c = document.createElement("div");
  c.className = cls;
  c.setAttribute("contenteditable", "false");
  const edge = top ? `top:${Math.max(6, px.padTop * 0.35)}px` : `bottom:${Math.max(6, px.padBottom * 0.35)}px`;
  c.style.cssText = `position:absolute;${edge};left:${px.padLeft}px;right:${px.padRight}px;color:#111`;
  c.innerHTML = html;
  return c;
}

/**
 * Distribute the surface's blocks onto fixed-height page sheets: fill a page
 * until the next block would overflow the content height, then start a new one;
 * an explicit page break forces the next block onto a fresh page. Blocks are
 * *moved* (never recreated), so the caret survives — it is saved and restored
 * around the reflow.
 */
function paginate(root: HTMLElement, px: PxMetrics, chrome?: WordChrome) {
  const blocks = topBlocks(root);
  if (blocks.length === 0) return;

  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0
    ? { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset }
    : null;

  // Stage 1: put every block in one page at the real content width, then measure
  // (height depends on width, so blocks must be measured at page width — not the
  // wider editor surface). No chrome while measuring.
  root.textContent = "";
  const stage = makePage(px);
  root.appendChild(stage);
  for (const b of blocks) stage.appendChild(b);
  const heights = new Map<HTMLElement, number>();
  for (const b of blocks) {
    const cs = getComputedStyle(b);
    heights.set(b, b.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
  }

  // Stage 2: fill pages until the next block would overflow; a page break forces
  // a fresh page. Each page carries the header/footer chrome.
  stage.remove(); // detaches stage + blocks (blocks stay referenced in `blocks`)
  let page = makePage(px, chrome);
  root.appendChild(page);
  let used = 0;
  let breakNext = false;
  for (const b of blocks) {
    const bh = heights.get(b) || 0;
    // break-before (Word's recorded page start) | break-after from a prior block |
    // height overflow. Only ever break when the current page already has content.
    const breakBefore = b.getAttribute?.("data-break-before") === "1";
    if (used > 0 && (breakNext || breakBefore || used + bh > px.contentH)) {
      page = makePage(px, chrome);
      root.appendChild(page);
      used = 0;
    }
    breakNext = false;
    page.appendChild(b);
    used += bh;
    if (b.matches?.(".qyra-pagebreak") || b.querySelector?.(".qyra-pagebreak")) breakNext = true;
  }

  if (saved && saved.an && root.contains(saved.an) && sel) {
    try { sel.setBaseAndExtent(saved.an, saved.ao, saved.fn || saved.an, saved.fo); } catch { /* caret lost, ignore */ }
  }
}

/**
 * Serialize the editor surface into the ordered block list the save path wants.
 * Untouched blocks (innerHTML matches their snapshot) become `verbatim` so the
 * backend re-emits their exact source bytes; changed / new paragraphs carry their
 * runs; touched tables are walked into rows/cells (untouched cells stay verbatim).
 */
function collectBlocks(root: HTMLElement, orig: Record<number, string>, cellOrig: Record<string, string>): BlockEdit[] {
  const out: BlockEdit[] = [];
  for (const el of topBlocks(root)) {
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
    const styleAttr = el.getAttribute("data-style");
    const indentAttr = el.getAttribute("data-indent");
    const lineAttr = el.getAttribute("data-line");
    const listAttr = el.getAttribute("data-list");
    const ilvlAttr = el.getAttribute("data-ilvl");
    if (origIdx != null && !styleAttr && !indentAttr && !lineAttr && !listAttr && el.innerHTML === orig[origIdx]) {
      out.push({ kind: "verbatim", orig: origIdx });
    } else {
      out.push({
        kind: "para", orig: origIdx, runs: collectRuns(el),
        align: mapAlign(getComputedStyle(el).textAlign),
        style: styleAttr ?? null,
        indent: indentAttr ? parseFloat(indentAttr) : null,
        line: lineAttr ? parseFloat(lineAttr) : null,
        list: (listAttr as "bullet" | "decimal" | "none" | null) ?? null,
        ilvl: ilvlAttr ? parseInt(ilvlAttr, 10) : null,
      });
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

/** First inline value of a CSS property on the run's span chain (up to the
 *  paragraph), i.e. an explicitly-set value rather than an inherited default. */
function inlineStyle(el: HTMLElement | null, prop: string): string {
  let n: HTMLElement | null = el;
  while (n && n.tagName && n.tagName.toLowerCase() !== "p") {
    const v = (n.style as unknown as Record<string, string>)[prop];
    if (v) return v;
    n = n.parentElement;
  }
  return "";
}

function primaryFont(fam: string): string | undefined {
  const f = fam.split(",")[0]?.replace(/["']/g, "").trim();
  return f || undefined;
}

/** Serialize a paragraph's inline content into formatting-grouped runs. Walks
 *  nodes in order so a page break (`.qyra-pagebreak`) survives an edit as a
 *  break run; markers/tabs are skipped, plain filler `<br>` is ignored. */
function collectRuns(p: HTMLElement): RunEdit[] {
  const runs: RunEdit[] = [];

  const pushText = (node: Text) => {
    const parent = node.parentElement;
    if (!parent) return;
    if (parent.closest(".qyra-marker") || parent.closest(".qyra-tab")) return;
    const text = node.textContent || "";
    if (!text) return;
    const cs = getComputedStyle(parent);
    const deco = cs.textDecorationLine || cs.textDecoration || "";
    const bold = cs.fontWeight === "bold" || parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const underline = deco.includes("underline");
    const strike = deco.includes("line-through");
    const color = rgbToHex(cs.color);
    const size_pt = pxToPt(cs.fontSize);
    const font = primaryFont(inlineStyle(parent, "fontFamily"));
    const bg = inlineStyle(parent, "backgroundColor");
    const highlight = bg ? rgbToHex(bg) : undefined;
    const va = cs.verticalAlign;
    const vert: "super" | "sub" | undefined = va === "super" ? "super" : va === "sub" ? "sub" : undefined;
    const last = runs[runs.length - 1];
    if (last && !last.br && !!last.bold === bold && !!last.italic === italic && !!last.underline === underline
      && !!last.strike === strike && last.color === color && last.size_pt === size_pt
      && last.font === font && last.highlight === highlight && last.vert === vert) {
      last.text += text;
    } else {
      runs.push({ text, bold, italic, underline, strike, color, size_pt, font, highlight, vert });
    }
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { pushText(node as Text); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains("qyra-pagebreak")) { runs.push({ text: "", br: "page" }); return; }
    if (el.classList.contains("qyra-marker") || el.classList.contains("qyra-tab")) return;
    for (const c of Array.from(el.childNodes)) visit(c);
  };

  for (const c of Array.from(p.childNodes)) visit(c);
  return runs;
}

const RIBBON_TABS = ["home", "insert", "table"] as const;
type RibbonTab = (typeof RIBBON_TABS)[number];

const FONTS = ["Calibri", "Arial", "Times New Roman", "Cambria", "Georgia", "Verdana", "Tahoma", "Courier New", "Segoe UI", "Comic Sans MS"];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const HIGHLIGHTS = ["FFFF00", "00FF00", "00FFFF", "FF00FF", "FF9900"];
const STYLES: { id: string; label: string }[] = [
  { id: "Normal", label: "Normal" },
  { id: "Title", label: "Title" },
  { id: "Heading1", label: "Heading 1" },
  { id: "Heading2", label: "Heading 2" },
  { id: "Heading3", label: "Heading 3" },
];

/** One labelled cluster of ribbon controls (Word's grouped-command layout). */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "2px 10px", borderRight: "1px solid var(--line)" }}>
      <div className="flex items-center gap-1" style={{ minHeight: 30 }}>{children}</div>
      <div style={{ fontSize: 10, color: "var(--fg2)", letterSpacing: 0.2 }}>{label}</div>
    </div>
  );
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
  const [tab, setTab] = useState<RibbonTab>("home");
  const [curFont, setCurFont] = useState("");
  const [curSize, setCurSize] = useState<number | "">("");
  const [curStyle, setCurStyle] = useState("Normal");
  const [pageCount, setPageCount] = useState(1);
  const [wordCount, setWordCount] = useState(0);
  const [curPage, setCurPage] = useState(1);
  const [zoom, setZoom] = useState(1);

  const editRef = useRef<HTMLDivElement>(null);
  const origHtmlRef = useRef<Record<number, string>>({});
  const origCellRef = useRef<Record<string, string>>({}); // "blockIdx:r:c" -> cell innerHTML
  const undoRef = useRef<string[]>([]);                    // structural-edit snapshots
  const metricsRef = useRef<WordPageMetrics>(DEFAULT_METRICS);
  const chromeRef = useRef<WordChrome>({ header: "", footer: "" });
  const repaginateTimer = useRef<number | null>(null);

  function reflow() {
    if (!editRef.current) return;
    paginate(editRef.current, metricsPx(metricsRef.current), chromeRef.current);
    updateStats();
  }
  function updateStats() {
    const root = editRef.current;
    if (!root) return;
    setPageCount(Math.max(1, root.querySelectorAll(".qyra-page").length));
    const txt = root.innerText || "";
    setWordCount((txt.match(/\S+/g) || []).length);
  }
  function onScrollPages(e: React.UIEvent<HTMLDivElement>) {
    const sc = e.currentTarget;
    const pages = editRef.current?.querySelectorAll<HTMLElement>(".qyra-page");
    if (!pages || pages.length === 0) return;
    const scTop = sc.getBoundingClientRect().top;
    let cur = 1;
    pages.forEach((pg, i) => { if (pg.getBoundingClientRect().top - scTop < 120) cur = i + 1; });
    setCurPage(Math.min(cur, pages.length));
  }

  // Apply the zoom level to the page surface (Chromium `zoom` scales cleanly).
  useEffect(() => {
    if (editRef.current) editRef.current.style.zoom = String(zoom);
  }, [zoom, html]);
  // Debounced reflow after typing (moving nodes on every keystroke would thrash).
  function scheduleReflow() {
    if (repaginateTimer.current != null) window.clearTimeout(repaginateTimer.current);
    repaginateTimer.current = window.setTimeout(() => { repaginateTimer.current = null; reflow(); }, 180);
  }

  // Load (and reload after a save) the document as editable HTML + page geometry.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setError(null);
    setStatus(null);
    setHtml(null);
    (async () => {
      try {
        const [h, m, c] = await Promise.all([
          getWordHtml(path),
          getWordMetrics(path).catch(() => DEFAULT_METRICS),
          getWordChrome(path).catch(() => ({ header: "", footer: "" })),
        ]);
        if (cancelled) return;
        metricsRef.current = m;
        chromeRef.current = c;
        setHtml(h);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [path, version]);

  // Inject into the editable surface, snapshot originals, then lay onto pages.
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
    reflow(); // lay the freshly-injected blocks onto page sheets
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editRef.current?.focus();
    reflow();
  }

  // Track table context + the caret's font/size so the ribbon reflects them.
  useEffect(() => {
    const onSel = () => {
      setInTable(caretCell() != null);
      const el = caretElement();
      if (el) {
        const cs = getComputedStyle(el);
        setCurFont(primaryFont(cs.fontFamily) ?? "");
        setCurSize(pxToPt(cs.fontSize) ?? "");
      }
      setCurStyle(caretParagraph()?.getAttribute("data-style") ?? "Normal");
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  /** The element at the caret, if inside the editor. */
  function caretElement(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node: Node | null = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const el = node as HTMLElement | null;
    if (!el || !editRef.current || !editRef.current.contains(el)) return null;
    return el;
  }

  /** The `<td>` containing the caret, if inside the editor. */
  function caretCell(): HTMLTableCellElement | null {
    return caretElement()?.closest("td") ?? null;
  }

  /** The top-level paragraph element containing the caret. */
  function caretParagraph(): HTMLElement | null {
    return (caretElement()?.closest("p") as HTMLElement | null) ?? null;
  }

  /** Apply a paragraph style (Normal / Heading n / Title): preview via a CSS
   *  class, and tag the paragraph so the save sets its `w:pStyle`. */
  function applyStyle(id: string) {
    const p = caretParagraph();
    if (!p) return;
    pushUndo();
    p.setAttribute("data-style", id);
    p.classList.remove("qs-Title", "qs-Heading1", "qs-Heading2", "qs-Heading3");
    if (id !== "Normal") p.classList.add("qs-" + id);
    setCurStyle(id);
    editRef.current?.focus();
    reflow();
  }

  /** Toggle the caret paragraph in/out of a bullet or numbered list. */
  function toggleList(kind: "bullet" | "decimal") {
    const p = caretParagraph();
    if (!p) return;
    pushUndo();
    const next = p.dataset.list === kind ? "none" : kind;
    p.dataset.list = next;
    p.classList.remove("qyra-li-bullet", "qyra-li-decimal");
    if (next === "bullet") p.classList.add("qyra-li-bullet");
    else if (next === "decimal") p.classList.add("qyra-li-decimal");
    editRef.current?.focus();
    reflow();
  }

  // ---- character formatting that must produce CSS spans (readable by collectRuns) ----
  function execCss(cmd: string, value?: string) {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, value);
    editRef.current?.focus();
    reflow();
  }
  function applyFont(family: string) {
    if (family) execCss("fontName", family);
  }
  function applySize(pt: number) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { editRef.current?.focus(); return; }
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.style.fontSize = pt + "pt";
    try {
      range.surroundContents(span);
    } catch {
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    editRef.current?.focus();
    reflow();
  }
  function applyHighlight(color: string | null) {
    document.execCommand("styleWithCSS", false, "true");
    const c = color ? "#" + color : "transparent";
    if (!document.execCommand("hiliteColor", false, c)) document.execCommand("backColor", false, c);
    editRef.current?.focus();
    reflow();
  }
  function indentBy(deltaPt: number) {
    const p = caretParagraph();
    if (!p) return;
    pushUndo();
    const cur = parseFloat(p.dataset.indent || "") || pxToPt(getComputedStyle(p).marginLeft) || 0;
    const next = Math.max(0, cur + deltaPt);
    p.dataset.indent = String(next);
    p.style.marginLeft = next + "pt";
    editRef.current?.focus();
    reflow();
  }
  function setLineSpacing(mult: number) {
    const p = caretParagraph();
    if (!p) return;
    pushUndo();
    p.dataset.line = String(mult);
    p.style.lineHeight = String(mult);
    editRef.current?.focus();
    reflow();
  }
  function clearFormat() {
    document.execCommand("removeFormat");
    const p = caretParagraph();
    if (p) { p.removeAttribute("data-style"); p.className = ""; setCurStyle("Normal"); }
    editRef.current?.focus();
    reflow();
  }
  // Native contenteditable undo/redo (covers typing + execCommand formatting);
  // the historyUndo input event re-triggers pagination.
  function undo() { document.execCommand("undo"); editRef.current?.focus(); }
  function redo() { document.execCommand("redo"); editRef.current?.focus(); }

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
      reflow();
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
    reflow();
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
    reflow();
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
    reflow();
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
    reflow();
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
    reflow();
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
    reflow();
  }
  function splitCell() {
    const td = caretCell();
    if (!td) return;
    pushUndo();
    td.colSpan = 1;
    td.rowSpan = 1;
    td.dataset.edited = "1";
    editRef.current?.focus();
    reflow();
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
    reflow();
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
    reflow();
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
    reflow();
  }

  /** Insert a page break as a new paragraph after the caret's block. */
  function insertPageBreak() {
    if (!editRef.current) return;
    pushUndo();
    const brP = document.createElement("p");
    brP.innerHTML = '<hr class="qyra-pagebreak" contenteditable="false">';
    const p = caretParagraph();
    if (p && p.parentElement) p.after(brP);
    else editRef.current.appendChild(brP);
    editRef.current.focus();
    reflow();
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
  const zbtn: React.CSSProperties = {
    width: 22, height: 20, background: "var(--bg0)", border: "1px solid var(--line)",
    borderRadius: 4, color: "var(--fg0)", cursor: "pointer", fontSize: 13, lineHeight: 1,
  };
  const selStyle: React.CSSProperties = {
    height: 28, background: "var(--bg0)", color: "var(--fg0)", border: "1px solid var(--line)",
    borderRadius: 5, fontSize: 12, padding: "0 4px", fontFamily: UI,
  };

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
        <>
          {/* Ribbon tab strip */}
          <div className="flex items-center shrink-0" style={{ height: 34, padding: "0 10px", gap: 2, background: "var(--bg1)", borderBottom: "1px solid var(--line)" }}>
            {RIBBON_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: tab === t ? "var(--bg0)" : "transparent",
                  color: tab === t ? "var(--fg0)" : "var(--fg1)",
                  border: "none",
                  borderBottom: tab === t ? "2px solid var(--accent, #3b6ea5)" : "2px solid transparent",
                  padding: "0 14px", height: "100%", cursor: "pointer", fontSize: 12.5,
                  fontWeight: tab === t ? 600 : 500, textTransform: "capitalize",
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Ribbon body */}
          <div className="flex items-stretch shrink-0 flex-wrap" style={{ minHeight: 58, padding: "5px 6px", background: "var(--bg1)", borderBottom: "1px solid var(--line2)" }}>
            {tab === "home" && (
              <>
                <Group label="Undo">
                  <button onMouseDown={(e) => { e.preventDefault(); undo(); }} title="Undo (Ctrl+Z)" style={tbtn}>↶</button>
                  <button onMouseDown={(e) => { e.preventDefault(); redo(); }} title="Redo (Ctrl+Y)" style={tbtn}>↷</button>
                </Group>
                <Group label="Font">
                  <select value={curFont} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => applyFont(e.target.value)} title="Font" style={{ ...selStyle, width: 124 }}>
                    <option value="" disabled>Font</option>
                    {[...new Set([curFont, ...FONTS].filter(Boolean))].map((f) => (
                      <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                    ))}
                  </select>
                  <select value={curSize === "" ? "" : String(curSize)} onChange={(e) => applySize(parseFloat(e.target.value))} title="Font size" style={{ ...selStyle, width: 56 }}>
                    <option value="" disabled>Size</option>
                    {[...new Set([...(curSize ? [curSize] : []), ...SIZES])].sort((a, b) => a - b).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <span style={sepStyle} />
                  {([["bold", "B", "Bold"], ["italic", "I", "Italic"], ["underline", "U", "Underline"]] as const).map(([cmd, label, title]) => (
                    <button key={cmd} onMouseDown={(e) => { e.preventDefault(); exec(cmd); }} title={title}
                      style={{ ...tbtn, fontWeight: cmd === "bold" ? 700 : 400, fontStyle: cmd === "italic" ? "italic" : "normal", textDecoration: cmd === "underline" ? "underline" : "none" }}>
                      {label}
                    </button>
                  ))}
                  <button onMouseDown={(e) => { e.preventDefault(); execCss("strikeThrough"); }} title="Strikethrough" style={{ ...tbtn, textDecoration: "line-through" }}>S</button>
                  <button onMouseDown={(e) => { e.preventDefault(); execCss("superscript"); }} title="Superscript" style={tbtn}>x²</button>
                  <button onMouseDown={(e) => { e.preventDefault(); execCss("subscript"); }} title="Subscript" style={tbtn}>x₂</button>
                  <span style={sepStyle} />
                  <label title="Text colour" style={{ ...tbtn, display: "inline-flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                    <span style={{ fontWeight: 700 }}>A</span>
                    <input type="color" onChange={(e) => execCss("foreColor", e.target.value)}
                      style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
                  </label>
                  {HIGHLIGHTS.map((c) => (
                    <button key={c} onMouseDown={(e) => { e.preventDefault(); applyHighlight(c); }} title={"Highlight #" + c}
                      style={{ width: 20, height: 20, background: "#" + c, border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer" }} />
                  ))}
                  <button onMouseDown={(e) => { e.preventDefault(); applyHighlight(null); }} title="No highlight" style={tbtn}>▨✕</button>
                  <button onMouseDown={(e) => { e.preventDefault(); clearFormat(); }} title="Clear formatting" style={tbtn}>⌫</button>
                </Group>
                <Group label="Paragraph">
                  {([["justifyLeft", "L", "Align left"], ["justifyCenter", "C", "Center"], ["justifyRight", "R", "Align right"], ["justifyFull", "J", "Justify"]] as const).map(([cmd, label, title]) => (
                    <button key={cmd} onMouseDown={(e) => { e.preventDefault(); exec(cmd); }} title={title} style={tbtn}>{label}</button>
                  ))}
                  <button onMouseDown={(e) => { e.preventDefault(); toggleList("bullet"); }} title="Bullet list" style={tbtn}>•≡</button>
                  <button onMouseDown={(e) => { e.preventDefault(); toggleList("decimal"); }} title="Numbered list" style={tbtn}>1.≡</button>
                  <span style={sepStyle} />
                  <button onMouseDown={(e) => { e.preventDefault(); indentBy(-36); }} title="Decrease indent" style={tbtn}>⇤</button>
                  <button onMouseDown={(e) => { e.preventDefault(); indentBy(36); }} title="Increase indent" style={tbtn}>⇥</button>
                  <select value="" onChange={(e) => setLineSpacing(parseFloat(e.target.value))} title="Line spacing" style={{ ...selStyle, width: 54 }}>
                    <option value="" disabled>↕</option>
                    {[1.0, 1.15, 1.5, 2.0].map((v) => <option key={v} value={v}>{v.toFixed(2)}</option>)}
                  </select>
                </Group>
                <Group label="Styles">
                  <select value={curStyle} onChange={(e) => applyStyle(e.target.value)} title="Paragraph style" style={{ ...selStyle, width: 112 }}>
                    {!STYLES.some((s) => s.id === curStyle) && curStyle && <option value={curStyle}>{curStyle}</option>}
                    {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </Group>
                <Group label="Editing">
                  <input style={inputStyle} placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
                  <input style={inputStyle} placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
                  <button onClick={doReplace} disabled={!find || saving} style={{ ...tbtn, width: "auto", padding: "5px 10px" }}>Replace all</button>
                </Group>
              </>
            )}

            {tab === "insert" && (
              <>
                <Group label="Tables">
                  <button onMouseDown={(e) => { e.preventDefault(); insertTable(); }} title="Insert a 2×2 table" style={wbtn}>▦ Table</button>
                </Group>
                <Group label="Pages">
                  <button onMouseDown={(e) => { e.preventDefault(); insertPageBreak(); }} title="Insert page break" style={wbtn}>⤓ Page break</button>
                </Group>
              </>
            )}

            {tab === "table" && (
              <>
                <Group label="Rows & Columns">
                  {([
                    ["Row ↑", () => insertRow(false), "Insert row above"],
                    ["Row ↓", () => insertRow(true), "Insert row below"],
                    ["Row ✕", deleteRow, "Delete row"],
                    ["Col ←", () => insertCol(false), "Insert column left"],
                    ["Col →", () => insertCol(true), "Insert column right"],
                    ["Col ✕", deleteCol, "Delete column"],
                  ] as const).map(([label, fn, title]) => (
                    <button key={label} disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); fn(); }} title={title} style={wbtn}>{label}</button>
                  ))}
                </Group>
                <Group label="Merge">
                  {([
                    ["Merge →", mergeRight, "Merge with cell to the right"],
                    ["Merge ↓", mergeDown, "Merge with cell below"],
                    ["Split", splitCell, "Split merged cell"],
                  ] as const).map(([label, fn, title]) => (
                    <button key={label} disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); fn(); }} title={title} style={wbtn}>{label}</button>
                  ))}
                </Group>
                <Group label="Shading & Borders">
                  {["FFFF00", "D9D9D9", "DEEAF6"].map((c) => (
                    <button key={c} disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); shadeCell(c); }} title={"Shade #" + c}
                      style={{ width: 20, height: 20, background: "#" + c, border: "1px solid var(--line)", borderRadius: 4, cursor: inTable ? "pointer" : "default", opacity: inTable ? 1 : 0.4 }} />
                  ))}
                  <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); shadeCell(null); }} title="Clear shading" style={wbtn}>Shade ✕</button>
                  <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); borderCell(true); }} title="Cell border on" style={wbtn}>▦</button>
                  <button disabled={!inTable} onMouseDown={(e) => { e.preventDefault(); borderCell(false); }} title="Cell border off" style={wbtn}>▢</button>
                </Group>
                <Group label="Undo">
                  <button onMouseDown={(e) => { e.preventDefault(); undoTable(); }} title="Undo last table change" style={wbtn}>↶ Undo</button>
                </Group>
              </>
            )}
          </div>
        </>
      )}

      <style>{`
        .qyra-page { background:#fff; color:#111; box-shadow:0 2px 10px rgba(0,0,0,0.35); border-radius:2px; margin:0 auto 22px; box-sizing:border-box; }
        .qyra-page:last-child { margin-bottom:0; }
        .qyra-pagebreak { border:none; border-top:1px dashed #c8c8c8; height:0; margin:6px 0; }
        .qyra-header, .qyra-footer { pointer-events:none; user-select:none; }
        .qyra-header p, .qyra-footer p { margin:2px 0; }
        .qs-Title, .qs-Title * { font-size:28pt !important; font-weight:700 !important; }
        .qs-Heading1, .qs-Heading1 * { font-size:16pt !important; font-weight:700 !important; color:#2e74b5 !important; }
        .qs-Heading2, .qs-Heading2 * { font-size:13pt !important; font-weight:700 !important; color:#2e74b5 !important; }
        .qs-Heading3, .qs-Heading3 * { font-size:12pt !important; font-weight:700 !important; color:#1f3864 !important; }
        .qyra-doc { counter-reset: qyra-ol; }
        .qyra-li-bullet { padding-left:26px; position:relative; }
        .qyra-li-bullet::before { content:"•"; position:absolute; left:10px; }
        .qyra-li-decimal { padding-left:30px; position:relative; counter-increment:qyra-ol; }
        .qyra-li-decimal::before { content:counter(qyra-ol) "."; position:absolute; left:6px; }
      `}</style>

      <div className="flex-1 overflow-auto" onScroll={onScrollPages} style={{ padding: 24, background: "var(--bg1)" }}>
        {error && <div role="alert" style={{ color: "#e07070", fontSize: 13, marginBottom: 16 }}>{error}</div>}

        {!path && !error && (
          <div style={{ color: "var(--fg2)", fontSize: 14, textAlign: "center", marginTop: 80 }}>
            Open a Word document to start editing.
          </div>
        )}

        {path && (
          <div style={{ width: "fit-content", minWidth: "100%", margin: "0 auto" }}>
            {html == null && !error && (
              <div style={{ color: "var(--fg2)", fontSize: 13, textAlign: "center", padding: 40 }}>Loading…</div>
            )}
            <div
              ref={editRef}
              className="qyra-doc"
              contentEditable={html != null}
              suppressContentEditableWarning
              spellCheck={false}
              onInput={scheduleReflow}
              style={{
                outline: "none",
                fontFamily: "Arial, Helvetica, sans-serif",
                lineHeight: 1.3,
                display: html == null ? "none" : "block",
              }}
            />
          </div>
        )}
      </div>

      {path && (
        <div className="flex items-center shrink-0" style={{ height: 26, padding: "0 14px", gap: 16, borderTop: "1px solid var(--line2)", background: "var(--bg1)", color: "var(--fg1)", fontSize: 11.5 }}>
          <span>Page {curPage} of {pageCount}</span>
          <span>{wordCount} {wordCount === 1 ? "word" : "words"}</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} title="Zoom out" style={zbtn}>−</button>
          <input type="range" min={50} max={200} step={10} value={Math.round(zoom * 100)} onChange={(e) => setZoom(parseInt(e.target.value, 10) / 100)} style={{ width: 110 }} />
          <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} title="Zoom in" style={zbtn}>+</button>
          <span style={{ width: 38, textAlign: "right" }}>{Math.round(zoom * 100)}%</span>
        </div>
      )}
    </div>
  );
}
