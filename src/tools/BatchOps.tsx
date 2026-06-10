import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ToolLayout } from "../components/ToolLayout";
import { pickDirectory } from "../lib/tauri";
import { UI, MONO } from "../lib/tokens";

type Op =
  | "compress"
  | "flatten"
  | "rotate"
  | "watermark"
  | "page-numbers"
  | "remove-metadata";

interface RowState {
  path: string;
  name: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  output?: string;
}

const ALL_OPS: { id: Op; label: string; desc: string }[] = [
  { id: "compress", label: "Compress (native)", desc: "Image downsampling + stream recompression on every file." },
  { id: "flatten", label: "Flatten", desc: "Bake annotations + form fields into page content." },
  { id: "rotate", label: "Rotate 90° CW", desc: "Rotate every page 90° clockwise." },
  { id: "watermark", label: "Watermark (DRAFT)", desc: "Add a default DRAFT diagonal watermark." },
  { id: "page-numbers", label: "Page numbers", desc: "Add bottom-center page numbers." },
  { id: "remove-metadata", label: "Anonymize metadata", desc: "Strip Info dict + XMP + auto-actions." },
];

const OPS = ALL_OPS;

function defaultSuffix(op: Op): string {
  return op;
}

function withSuffix(path: string, suffix: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = path.lastIndexOf(".");
  if (idx <= path.lastIndexOf(sep)) return `${path}_${suffix}.pdf`;
  return `${path.slice(0, idx)}_${suffix}${path.slice(idx)}`;
}

function joinPath(dir: string, name: string, suffix: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  const stem = name.replace(/\.pdf$/i, "");
  return `${trimmed}${sep}${stem}_${suffix}.pdf`;
}

export default function BatchOps() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [op, setOp] = useState<Op>("compress");
  const [destDir, setDestDir] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function pickFiles() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setRows((existing) => {
      const existingPaths = new Set(existing.map((r) => r.path));
      const additions: RowState[] = paths
        .filter((p) => !existingPaths.has(p))
        .map((p) => ({
          path: p,
          name: p.split(/[\\/]/).pop() ?? p,
          status: "pending",
        }));
      return [...existing, ...additions];
    });
  }

  async function pickDest() {
    const dir = await pickDirectory();
    if (dir) setDestDir(dir);
  }

  function clearAll() { setRows([]); }
  function removeRow(idx: number) { setRows((r) => r.filter((_, i) => i !== idx)); }

  function outputFor(row: RowState): string {
    const suffix = defaultSuffix(op);
    return destDir ? joinPath(destDir, row.name, suffix) : withSuffix(row.path, suffix);
  }

  async function runOne(row: RowState, output: string): Promise<string> {
    switch (op) {
      case "compress":
        await invoke("compress_pdf", { path: row.path, output, level: 2 });
        return output;
      case "flatten":
        await invoke("flatten_pdf", { path: row.path, output });
        return output;
      case "rotate":
        // Rotate every page 90 deg CW. pages omitted = all.
        await invoke("rotate_pages", { path: row.path, pages: [], degrees: 90, output });
        return output;
      case "watermark":
        await invoke("add_watermark", {
          path: row.path,
          options: { text: "DRAFT", opacity: 0.25, angle: 45, mode: "diagonal" },
          output,
        });
        return output;
      case "page-numbers":
        await invoke("add_page_numbers", {
          path: row.path,
          options: { startAt: 1, position: "bottom-center", fontSize: 10, margin: 20 },
          output,
        });
        return output;
      case "remove-metadata":
        await invoke("anonymize_pdf", {
          path: row.path,
          options: {
            stripInfo: true,
            stripXmpMetadata: true,
            stripJavascript: true,
            stripEmbeddedFiles: true,
            stripOpenActions: true,
            stripAnnotAuthors: true,
          },
          output,
        });
        return output;
    }
  }

  async function runAll() {
    if (rows.length === 0 || running) return;
    setRunning(true);
    // Reset statuses.
    setRows((arr) => arr.map((r) => ({ ...r, status: "pending", message: undefined, output: undefined })));
    for (let i = 0; i < rows.length; i++) {
      setRows((arr) => arr.map((r, idx) => (idx === i ? { ...r, status: "running" } : r)));
      try {
        const row = rows[i]!;
        const target = outputFor(row);
        const out = await runOne(row, target);
        setRows((arr) => arr.map((r, idx) => (idx === i ? { ...r, status: "done", output: out } : r)));
      } catch (e: any) {
        setRows((arr) => arr.map((r, idx) => (idx === i ? { ...r, status: "error", message: String(e?.message ?? e) } : r)));
      }
    }
    setRunning(false);
  }

  const done = rows.filter((r) => r.status === "done").length;
  const failed = rows.filter((r) => r.status === "error").length;

  return (
    <ToolLayout title="Batch operations" description="Apply one operation to many PDFs">
      <section style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: UI }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={pickFiles} disabled={running} className="btn-secondary">Add PDFs…</button>
          <button onClick={pickDest} disabled={running} className="btn-secondary">
            {destDir ? "Change output folder" : "Output folder (same as input)"}
          </button>
          {rows.length > 0 && (
            <button onClick={clearAll} disabled={running} className="btn-secondary">Clear</button>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={runAll}
            disabled={running || rows.length === 0}
            className="btn-primary"
          >
            {running ? "Running…" : `Run on ${rows.length} file${rows.length === 1 ? "" : "s"}`}
          </button>
        </div>

        {destDir && (
          <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg2)" }}>
            Output → {destDir}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, color: "var(--fg2)" }}>Operation</label>
          <select
            value={op}
            onChange={(e) => setOp(e.target.value as Op)}
            disabled={running}
            style={{
              padding: "6px 8px",
              background: "var(--bg2)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--fg0)",
              fontSize: 13,
            }}
          >
            {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--fg2)" }}>
            {OPS.find((o) => o.id === op)?.desc}
          </p>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              padding: "32px 16px",
              border: "1px dashed var(--line)",
              borderRadius: 8,
              fontSize: 12.5, color: "var(--fg2)", textAlign: "center",
              background: "var(--bg1)",
            }}
          >
            Add PDF files to batch.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {rows.map((row, idx) => (
              <li
                key={row.path}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: 8,
                  alignItems: "center",
                  padding: "6px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  background: "var(--bg1)",
                  fontSize: 12.5,
                }}
              >
                <StatusDot status={row.status} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {row.name}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg2)" }}>
                  {row.status === "error" ? row.message : row.status === "done" ? "OK" : row.status}
                </span>
                <button
                  onClick={() => removeRow(idx)}
                  disabled={running}
                  style={{
                    width: 22, height: 22,
                    background: "transparent",
                    color: "var(--fg2)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    cursor: running ? "not-allowed" : "pointer",
                  }}
                  aria-label="Remove"
                >×</button>
              </li>
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--fg2)", fontFamily: MONO }}>
            {done} done · {failed} failed · {rows.length - done - failed} pending
          </div>
        )}
      </section>
    </ToolLayout>
  );
}

function StatusDot({ status }: { status: RowState["status"] }) {
  const color =
    status === "done" ? "var(--v-ok-text, #22c55e)" :
    status === "error" ? "var(--v-bad-text, #ef4444)" :
    status === "running" ? "var(--accent)" :
    "var(--fg3)";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8, height: 8, borderRadius: "50%",
        background: color, display: "inline-block",
        animation: status === "running" ? "spin 1s linear infinite" : undefined,
      }}
    />
  );
}
