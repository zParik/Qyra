import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
  currentPage: number;
}

interface PageLink {
  x0: number; y0: number; x1: number; y1: number;
  uri: string;
  page: number | null;
}

export function LinksPanel({ file, onApplied, currentPage }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [links, setLinks] = useState<PageLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<"uri" | "page">("uri");
  const [uri, setUri] = useState("https://");
  const [destPage, setDestPage] = useState(1);
  const [rect, setRect] = useState({ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.15 });

  async function reload() {
    setLoading(true);
    try {
      const data = await invoke<PageLink[]>("get_page_links", {
        path: file.path,
        page: currentPage,
      });
      setLinks(data);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, [file.path, currentPage]);

  async function handleAdd() {
    await run(async () => {
      const newPath = await invoke<string>("add_link", {
        path: file.path,
        link: {
          page: currentPage,
          x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1,
          uri: target === "uri" ? uri : null,
          destPage: target === "page" ? destPage : null,
        },
      });
      return newPath;
    });
  }

  async function handleRemove(idx: number) {
    await run(async () => {
      return invoke<string>("remove_link", {
        path: file.path,
        page: currentPage,
        index: idx,
      });
    });
  }

  return (
    <ToolPanelLayout
      onSubmit={handleAdd}
      submitLabel="Add link to page"
      submitClassName="v-btn-primary w-full"
      submitDisabled={target === "uri" ? !uri.trim() : destPage < 1}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Edit hyperlinks on page <strong>{currentPage}</strong>. Coordinates are
        normalized (0 = top/left, 1 = bottom/right).
      </p>

      <div
        style={{
          border: "1px solid var(--viewer-border)",
          borderRadius: 6,
          padding: "8px 10px",
          display: "flex", flexDirection: "column", gap: 6,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--viewer-text-sec)" }}>
          New link
        </div>

        <div style={{ display: "flex", gap: 6, fontSize: 11 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input type="radio" checked={target === "uri"} onChange={() => setTarget("uri")} />
            URL
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input type="radio" checked={target === "page"} onChange={() => setTarget("page")} />
            Page
          </label>
        </div>

        {target === "uri" ? (
          <input
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="https://example.com"
            style={inputStyle}
          />
        ) : (
          <input
            type="number"
            min={1}
            value={destPage}
            onChange={(e) => setDestPage(Math.max(1, parseInt(e.target.value) || 1))}
            style={inputStyle}
          />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <NumField label="x0" value={rect.x0} onChange={(v) => setRect({ ...rect, x0: v })} />
          <NumField label="y0" value={rect.y0} onChange={(v) => setRect({ ...rect, y0: v })} />
          <NumField label="x1" value={rect.x1} onChange={(v) => setRect({ ...rect, x1: v })} />
          <NumField label="y1" value={rect.y1} onChange={(v) => setRect({ ...rect, y1: v })} />
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, fontWeight: 600, color: "var(--viewer-text-sec)" }}>
        Existing links on this page
      </div>
      {loading ? (
        <div style={{ fontSize: 11, color: "var(--viewer-text-muted)" }}>Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--viewer-text-muted)" }}>None</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {links.map((link, idx) => (
            <li
              key={idx}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 8px",
                border: "1px solid var(--viewer-border)",
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--viewer-text)" }}>
                {link.uri || (link.page != null ? `→ page ${link.page}` : "(empty)")}
              </span>
              <button
                onClick={() => handleRemove(idx)}
                disabled={isProcessing}
                style={{
                  padding: "2px 6px",
                  background: "transparent",
                  color: "var(--v-bad-text)",
                  border: "1px solid var(--v-bad-border)",
                  borderRadius: 4, fontSize: 10.5,
                  cursor: isProcessing ? "not-allowed" : "pointer",
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </ToolPanelLayout>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  background: "var(--viewer-elevated)",
  color: "var(--viewer-text)",
  border: "1px solid var(--viewer-border)",
  borderRadius: 4,
  fontSize: 11.5,
};

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--viewer-text-muted)" }}>{label}</span>
      <input
        type="number"
        step={0.01}
        min={0} max={1}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          onChange(Math.min(1, Math.max(0, v)));
        }}
        style={inputStyle}
      />
    </label>
  );
}
