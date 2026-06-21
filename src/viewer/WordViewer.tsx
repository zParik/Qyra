import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getWordHtml, setWordParagraphRuns, saveWordBody, replaceInWord, type RunEdit,
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

  const editRef = useRef<HTMLDivElement>(null);
  const origHtmlRef = useRef<Record<number, string>>({});

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
    editRef.current.querySelectorAll<HTMLElement>("[data-p]").forEach((n) => {
      const i = parseInt(n.getAttribute("data-p") || "-1", 10);
      if (i >= 0) map[i] = n.innerHTML;
    });
    origHtmlRef.current = map;
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* ignore */ }
  }, [html]);

  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    editRef.current?.focus();
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
      const topParas = Array.from(editRef.current.querySelectorAll<HTMLElement>(":scope > p"));
      const origCount = Object.keys(origHtmlRef.current).length;

      if (topParas.length !== origCount) {
        const paras = topParas.map((p) => ({ runs: collectRuns(p), align: mapAlign(getComputedStyle(p).textAlign) }));
        await saveWordBody(path, paras, path);
        setStatus(`Saved (${paras.length} paragraphs).`);
      } else {
        let changed = 0;
        for (const n of Array.from(editRef.current.querySelectorAll<HTMLElement>("[data-p]"))) {
          const idx = parseInt(n.getAttribute("data-p") || "-1", 10);
          if (idx < 0 || n.innerHTML === origHtmlRef.current[idx]) continue;
          await setWordParagraphRuns(path, idx, collectRuns(n), mapAlign(getComputedStyle(n).textAlign), path);
          changed++;
        }
        setStatus(changed ? `Saved ${changed} edit${changed === 1 ? "" : "s"}.` : "No changes.");
      }
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
