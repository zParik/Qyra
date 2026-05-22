import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MONO } from "../lib/tokens";

interface Props {
  pathA: string;
  pathB: string;
  onClose: () => void;
}

function basename(p: string): string {
  const m = p.replace(/\\/g, "/").split("/");
  return m[m.length - 1] || p;
}

export function CompareView({ pathA, pathB, onClose }: Props) {
  const [page, setPage] = useState(1);
  const [pageCountA, setPageCountA] = useState(0);
  const [pageCountB, setPageCountB] = useState(0);
  const [imgA, setImgA] = useState<string | null>(null);
  const [imgB, setImgB] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errA, setErrA] = useState<string | null>(null);
  const [errB, setErrB] = useState<string | null>(null);

  // Load page counts once
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<number>("get_page_count", { path: pathA }).catch(() => 0),
      invoke<number>("get_page_count", { path: pathB }).catch(() => 0),
    ]).then(([a, b]) => {
      if (cancelled) return;
      setPageCountA(a);
      setPageCountB(b);
    });
    return () => { cancelled = true; };
  }, [pathA, pathB]);

  const maxPages = Math.max(pageCountA, pageCountB);

  // Render both pages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrA(null);
    setErrB(null);

    const renderA = page <= pageCountA
      ? invoke<string>("render_page_uncached", { path: pathA, page, scale: 1.5 })
          .then((b64) => { if (!cancelled) setImgA(`data:image/jpeg;base64,${b64}`); })
          .catch((e) => { if (!cancelled) { setImgA(null); setErrA(String(e)); } })
      : Promise.resolve().then(() => { if (!cancelled) setImgA(null); });

    const renderB = page <= pageCountB
      ? invoke<string>("render_page_uncached", { path: pathB, page, scale: 1.5 })
          .then((b64) => { if (!cancelled) setImgB(`data:image/jpeg;base64,${b64}`); })
          .catch((e) => { if (!cancelled) { setImgB(null); setErrB(String(e)); } })
      : Promise.resolve().then(() => { if (!cancelled) setImgB(null); });

    Promise.all([renderA, renderB]).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [page, pathA, pathB, pageCountA, pageCountB]);

  const next = useCallback(() => setPage((p) => Math.min(p + 1, maxPages)), [maxPages]);
  const prev = useCallback(() => setPage((p) => Math.max(p - 1, 1)), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }
      else if (e.key === "Escape") onClose();
      else if (e.key === "Home") setPage(1);
      else if (e.key === "End") setPage(maxPages);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose, maxPages]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(10, 10, 10, 0.96)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.85)",
          fontFamily: MONO,
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 600 }}>Compare</span>
          <span style={{ opacity: 0.6 }}>{basename(pathA)} ↔ {basename(pathB)}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={prev}
            disabled={page <= 1}
            style={btnStyle(page <= 1)}
          >
            ◀
          </button>
          <span>Page {page} / {maxPages}</span>
          <button
            onClick={next}
            disabled={page >= maxPages}
            style={btnStyle(page >= maxPages)}
          >
            ▶
          </button>
          <button onClick={onClose} style={btnStyle(false)}>Close</button>
        </div>
      </div>

      {/* Side-by-side panes */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", gap: 1, background: "rgba(255,255,255,0.06)" }}>
        <Pane
          label={basename(pathA)}
          img={imgA}
          err={errA}
          loading={loading && imgA === null}
          overflow={page > pageCountA}
        />
        <Pane
          label={basename(pathB)}
          img={imgB}
          err={errB}
          loading={loading && imgB === null}
          overflow={page > pageCountB}
        />
      </div>
    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "rgba(255,255,255,0.85)",
    padding: "3px 10px",
    borderRadius: 4,
    fontFamily: MONO,
    fontSize: 12,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
  };
}

function Pane({ label, img, err, loading, overflow }: {
  label: string;
  img: string | null;
  err: string | null;
  loading: boolean;
  overflow: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        overflow: "auto",
        position: "relative",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontFamily: MONO,
          fontSize: 11,
          color: "rgba(255,255,255,0.6)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          position: "sticky",
          top: 0,
          background: "#0a0a0a",
          zIndex: 1,
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
      >
        {overflow ? (
          <span style={{ color: "rgba(255,255,255,0.35)", fontFamily: MONO, fontSize: 12 }}>
            (no page at this index)
          </span>
        ) : err ? (
          <span style={{ color: "#f87171", fontFamily: MONO, fontSize: 12 }}>{err}</span>
        ) : img ? (
          <img
            src={img}
            alt={label}
            draggable={false}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
          />
        ) : loading ? (
          <span style={{ color: "rgba(255,255,255,0.3)", fontFamily: MONO, fontSize: 12 }}>Loading…</span>
        ) : null}
      </div>
    </div>
  );
}
