import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ToolLayout } from "../components/ToolLayout";
import { UI } from "../lib/tokens";

interface RepairReport {
  output: string;
  mode: "strict" | "rasterize";
  pageCount: number;
  bytesBefore: number;
  bytesAfter: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RepairPdf() {
  const [path, setPath] = useState<string | null>(null);
  const [allowRasterize, setAllowRasterize] = useState(false);
  const [dpi, setDpi] = useState(200);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RepairReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    setPath(Array.isArray(selected) ? selected[0]! : selected);
    setReport(null);
    setErr(null);
  }

  async function run() {
    if (!path) return;
    setRunning(true);
    setReport(null);
    setErr(null);
    try {
      const r = await invoke<RepairReport>("repair_pdf", {
        path,
        options: { allowRasterize, rasterizeDpi: dpi },
      });
      setReport(r);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <ToolLayout title="Repair PDF" description="Try to recover a damaged or unreadable file." family="pages">
      <section style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: UI }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={pick} className="btn-secondary" disabled={running}>
            {path ? "Choose another PDF" : "Pick PDF"}
          </button>
          <button
            onClick={run}
            disabled={!path || running}
            className="btn-primary"
            style={{ marginLeft: "auto" }}
          >
            {running ? "Repairing…" : "Repair"}
          </button>
        </div>

        {path && (
          <div style={{ fontFamily: UI, fontSize: "var(--fs-label)", color: "var(--fg2)", wordBreak: "break-all" }}>
            Input → {path}
          </div>
        )}

        <fieldset
          style={{
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "10px 12px",
            display: "flex", flexDirection: "column", gap: 6,
          }}
          disabled={running}
        >
          <legend style={{ padding: "0 6px", fontSize: "var(--fs-label)", color: "var(--fg2)" }}>Fallback</legend>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-body)" }}>
            <input
              type="checkbox"
              checked={allowRasterize}
              onChange={(e) => setAllowRasterize(e.target.checked)}
            />
            <span>
              If strict rewrite fails, rasterize pages via MuPDF.{" "}
              <span style={{ color: "var(--fg2)" }}>
                Loses text selection and links — last resort.
              </span>
            </span>
          </label>
          {allowRasterize && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-body)" }}>
              <span>DPI</span>
              <input
                type="number"
                min={72} max={600} step={10}
                value={dpi}
                onChange={(e) => setDpi(Math.max(72, Math.min(600, parseInt(e.target.value) || 200)))}
                style={{
                  width: 80,
                  padding: "4px 6px",
                  background: "var(--bg2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  color: "var(--fg0)",
                  fontSize: "var(--fs-body)",
                }}
              />
            </label>
          )}
        </fieldset>

        {err && (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid var(--bad-border)",
              background: "var(--bad-bg)",
              color: "var(--bad-text)",
              borderRadius: 6,
              fontSize: "var(--fs-body)",
            }}
          >
            {err}
          </div>
        )}

        {report && (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid var(--ok-border)",
              background: "var(--ok-bg)",
              color: "var(--ok-text)",
              borderRadius: 6,
              display: "flex", flexDirection: "column", gap: 4,
              fontSize: "var(--fs-body)",
            }}
          >
            <strong>Repair succeeded — {report.mode} mode</strong>
            <span style={{ fontFamily: UI, fontSize: "var(--fs-label)" }}>{report.output}</span>
            <span style={{ fontSize: "var(--fs-label)" }}>
              {report.pageCount} pages · {formatBytes(report.bytesBefore)} → {formatBytes(report.bytesAfter)}
            </span>
          </div>
        )}
      </section>
    </ToolLayout>
  );
}
