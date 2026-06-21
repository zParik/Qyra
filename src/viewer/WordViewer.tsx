import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  openWord, renderWordPage, replaceInWord,
  getWordHtml, setWordParagraphRuns, type WordDocInfo, type RunEdit,
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

const SCALE = 1.5; // device px per point (~108 DPI)

/**
 * .docx viewer + basic editor. Opens a document via the native Word engine
 * (Rust: parse → layout → rasterize) and shows each page as a rendered PNG.
 * Basic editing: find & replace in the body, saved losslessly in place.
 */
export default function WordViewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = (location.state as { path?: string; name?: string } | null) ?? null;

  const [path, setPath] = useState<string | null>(initial?.path ?? null);
  const [name, setName] = useState<string | null>(initial?.name ?? null);
  const [info, setInfo] = useState<WordDocInfo | null>(null);
  const [pages, setPages] = useState<(string | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bump to force a reload after edits

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editHtml, setEditHtml] = useState("");
  const [savingAll, setSavingAll] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const origHtmlRef = useRef<Record<number, string>>({});

  async function enterEdit() {
    if (!path) return;
    try {
      const html = await getWordHtml(path);
      // Snapshot each paragraph's original innerHTML to detect edits on save.
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const map: Record<number, string> = {};
      tmp.querySelectorAll<HTMLElement>("[data-p]").forEach((n) => {
        const i = parseInt(n.getAttribute("data-p") || "-1", 10);
        if (i >= 0) map[i] = n.innerHTML;
      });
      origHtmlRef.current = map;
      setEditHtml(html);
      setEditing(true);
      setStatus(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  // Inject the document HTML into the contenteditable surface once per edit.
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.innerHTML = editHtml;
    }
  }, [editing, editHtml]);

  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editRef.current?.focus();
  }

  async function saveAll() {
    if (!path || savingAll || !editRef.current) return;
    setSavingAll(true);
    setError(null);
    try {
      let changed = 0;
      for (const n of Array.from(editRef.current.querySelectorAll<HTMLElement>("[data-p]"))) {
        const idx = parseInt(n.getAttribute("data-p") || "-1", 10);
        if (idx < 0) continue;
        if (n.innerHTML === origHtmlRef.current[idx]) continue; // unchanged → byte-preserved
        const align = mapAlign(getComputedStyle(n).textAlign);
        await setWordParagraphRuns(path, idx, collectRuns(n), align, path);
        changed++;
      }
      setEditing(false);
      setStatus(changed ? `Saved ${changed} edit${changed === 1 ? "" : "s"}.` : "No changes.");
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingAll(false);
    }
  }

  async function browse() {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "Word Documents", extensions: ["docx"] }] });
      if (!sel) return;
      const p = Array.isArray(sel) ? sel[0]! : sel;
      setPath(p);
      setName(p.split(/[\\/]/).pop() ?? p);
      setStatus(null);
    } catch { /* dismissed */ }
  }

  async function doReplace() {
    if (!path || !find || busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await replaceInWord(path, find, replace, path);
      setStatus(`Replaced “${find}” → “${replace}” and saved.`);
      setVersion((v) => v + 1); // reload rendered pages from the edited file
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setError(null);
    setInfo(null);
    setPages([]);
    (async () => {
      try {
        const i = await openWord(path);
        if (cancelled) return;
        setInfo(i);
        setPages(new Array(i.pageCount).fill(null));
        for (let p = 0; p < i.pageCount; p++) {
          const b64 = await renderWordPage(path, p, SCALE);
          if (cancelled) return;
          setPages((prev) => {
            const next = [...prev];
            next[p] = b64;
            return next;
          });
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [path, version]);

  const inputStyle: React.CSSProperties = {
    background: "var(--bg0)", border: "1px solid var(--line)", borderRadius: 5,
    color: "var(--fg0)", fontSize: 12.5, padding: "4px 8px", width: 140, fontFamily: UI,
  };

  return (
    <div className="flex flex-col" style={{ height: "100dvh", background: "var(--bg0)", fontFamily: UI }}>
      <header
        className="flex items-center gap-3 shrink-0"
        style={{ height: 44, padding: "0 14px", borderBottom: "1px solid var(--line2)", color: "var(--fg0)" }}
      >
        <button
          onClick={() => navigate("/")}
          style={{ background: "transparent", border: "none", color: "var(--fg1)", cursor: "pointer", fontSize: 13 }}
        >
          ← Home
        </button>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{name ?? "Word viewer"}</span>
        {info && <span style={{ color: "var(--fg2)", fontSize: 12 }}>{info.pageCount} page{info.pageCount === 1 ? "" : "s"}</span>}
        <span style={{ flex: 1 }} />
        {path && !editing && (
          <button
            onClick={enterEdit}
            style={{
              background: "var(--bg1)", border: "1px solid var(--line)", borderRadius: 6,
              color: "var(--fg0)", cursor: "pointer", fontSize: 12.5, padding: "5px 12px",
            }}
          >
            Edit text
          </button>
        )}
        {path && editing && (
          <>
            <button
              onClick={saveAll}
              disabled={savingAll}
              style={{
                background: "var(--accent, #3b6ea5)", border: "1px solid var(--line)", borderRadius: 6,
                color: "#fff", cursor: savingAll ? "default" : "pointer", fontSize: 12.5, padding: "5px 12px",
              }}
            >
              {savingAll ? "Saving…" : "Save all"}
            </button>
            <button
              onClick={() => setEditing(false)}
              style={{
                background: "transparent", border: "1px solid var(--line)", borderRadius: 6,
                color: "var(--fg1)", cursor: "pointer", fontSize: 12.5, padding: "5px 12px",
              }}
            >
              Cancel
            </button>
          </>
        )}
        <button
          onClick={browse}
          style={{
            background: "var(--bg1)", border: "1px solid var(--line)", borderRadius: 6,
            color: "var(--fg0)", cursor: "pointer", fontSize: 12.5, padding: "5px 12px",
          }}
        >
          Open .docx
        </button>
      </header>

      {path && !editing && (
        <div
          className="flex items-center gap-2 shrink-0 flex-wrap"
          style={{ padding: "8px 14px", borderBottom: "1px solid var(--line2)" }}
        >
          <span style={{ color: "var(--fg2)", fontSize: 12 }}>Find/replace:</span>
          <input style={inputStyle} placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
          <input style={inputStyle} placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
          <button
            onClick={doReplace}
            disabled={!find || busy}
            style={{
              background: find && !busy ? "var(--accent, #3b6ea5)" : "var(--bg1)",
              border: "1px solid var(--line)", borderRadius: 6,
              color: find && !busy ? "#fff" : "var(--fg2)",
              cursor: find && !busy ? "pointer" : "default",
              fontSize: 12.5, padding: "5px 12px",
            }}
          >
            {busy ? "Saving…" : "Replace & save"}
          </button>
          {status && <span style={{ color: "var(--fg2)", fontSize: 12 }}>{status}</span>}
        </div>
      )}

      <div className="flex-1 overflow-auto" style={{ padding: 24 }}>
        {error && (
          <div role="alert" style={{ color: "#e07070", fontSize: 13, marginBottom: 16 }}>{error}</div>
        )}

        {!path && !error && (
          <div style={{ color: "var(--fg2)", fontSize: 14, textAlign: "center", marginTop: 80 }}>
            Open a Word document to view and edit it.
          </div>
        )}

        {editing ? (
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: 10 }}>
              {([["bold", "B"], ["italic", "I"], ["underline", "U"]] as const).map(([cmd, label]) => (
                <button
                  key={cmd}
                  onMouseDown={(e) => { e.preventDefault(); exec(cmd); }}
                  title={cmd}
                  style={{
                    width: 30, height: 28, background: "var(--bg1)", border: "1px solid var(--line)",
                    borderRadius: 5, color: "var(--fg0)", cursor: "pointer", fontSize: 13,
                    fontWeight: cmd === "bold" ? 700 : 400,
                    fontStyle: cmd === "italic" ? "italic" : "normal",
                    textDecoration: cmd === "underline" ? "underline" : "none",
                  }}
                >
                  {label}
                </button>
              ))}
              <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
              {([["justifyLeft", "L", "Align left"], ["justifyCenter", "C", "Align center"], ["justifyRight", "R", "Align right"], ["justifyFull", "J", "Justify"]] as const).map(([cmd, label, title]) => (
                <button
                  key={cmd}
                  onMouseDown={(e) => { e.preventDefault(); exec(cmd); }}
                  title={title}
                  style={{
                    width: 30, height: 28, background: "var(--bg1)", border: "1px solid var(--line)",
                    borderRadius: 5, color: "var(--fg0)", cursor: "pointer", fontSize: 12,
                  }}
                >
                  {label}
                </button>
              ))}
              <span style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
              {["000000", "C00000", "2E5BBA", "2E7D32"].map((c) => (
                <button
                  key={c}
                  onMouseDown={(e) => { e.preventDefault(); exec("foreColor", "#" + c); }}
                  title={"Color #" + c}
                  style={{ width: 22, height: 22, background: "#" + c, border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer" }}
                />
              ))}
              <span style={{ color: "var(--fg2)", fontSize: 12, marginLeft: 8 }}>
                Type like a document — bold/italic/underline, alignment, and color persist on save (edited paragraphs); untouched ones stay byte-identical.
              </span>
            </div>
            <div
              ref={editRef}
              contentEditable
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
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center" style={{ gap: 20 }}>
            {pages.map((b64, i) => {
              const size = info?.pages[i];
              const wPx = size ? size.width * SCALE : 612 * SCALE;
              const hPx = size ? size.height * SCALE : 792 * SCALE;
              return (
                <div
                  key={i}
                  style={{
                    width: wPx,
                    maxWidth: "100%",
                    aspectRatio: `${wPx} / ${hPx}`,
                    background: "#fff",
                    boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {b64 ? (
                    <img
                      src={`data:image/png;base64,${b64}`}
                      alt={`Page ${i + 1}`}
                      style={{ width: "100%", height: "100%", display: "block" }}
                    />
                  ) : (
                    <span style={{ color: "#999", fontSize: 12 }}>Rendering page {i + 1}…</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
