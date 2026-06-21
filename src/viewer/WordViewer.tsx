import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  openWord, renderWordPage, replaceInWord,
  getWordParagraphs, setWordParagraph, type WordDocInfo,
} from "../lib/tauri";
import { UI } from "../lib/tokens";

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
  const [paras, setParas] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [savingAll, setSavingAll] = useState(false);

  async function enterEdit() {
    if (!path) return;
    try {
      const ps = await getWordParagraphs(path);
      setParas(ps);
      setDraft([...ps]);
      setEditing(true);
      setStatus(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveAll() {
    if (!path || savingAll) return;
    setSavingAll(true);
    setError(null);
    try {
      let changed = 0;
      for (let i = 0; i < draft.length; i++) {
        if (draft[i] !== paras[i]) {
          await setWordParagraph(path, i, draft[i]!, path);
          changed++;
        }
      }
      setEditing(false);
      setStatus(changed ? `Saved ${changed} paragraph edit${changed === 1 ? "" : "s"}.` : "No changes.");
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
          <div className="flex flex-col" style={{ gap: 10, maxWidth: 820, margin: "0 auto" }}>
            <div style={{ color: "var(--fg2)", fontSize: 12 }}>
              Editing body paragraphs (text only — a paragraph's mixed formatting collapses to its first run).
              Changed paragraphs are outlined; “Save all” writes them back losslessly.
            </div>
            {draft.map((t, i) => (
              <textarea
                key={i}
                value={t}
                onChange={(e) =>
                  setDraft((d) => {
                    const n = [...d];
                    n[i] = e.target.value;
                    return n;
                  })
                }
                rows={Math.min(8, Math.max(1, Math.ceil((t.length || 1) / 90)))}
                style={{
                  width: "100%",
                  background: "var(--bg1)",
                  color: "var(--fg0)",
                  border: `1px solid ${t !== paras[i] ? "var(--accent, #3b6ea5)" : "var(--line)"}`,
                  borderRadius: 6,
                  padding: "6px 9px",
                  fontFamily: UI,
                  fontSize: 13,
                  resize: "vertical",
                }}
              />
            ))}
            {draft.length === 0 && (
              <div style={{ color: "var(--fg2)", fontSize: 13 }}>No editable body paragraphs found.</div>
            )}
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
