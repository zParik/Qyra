import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

interface Zones {
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
}

interface Options {
  zones: Zones;
  fontSize: number;
  margin: number;
  startPage: number;
  endPage: number | null;
}

interface Report {
  output: string;
  pagesStamped: number;
}

const EMPTY: Zones = {
  headerLeft: "",
  headerCenter: "",
  headerRight: "",
  footerLeft: "",
  footerCenter: "{page} / {total}",
  footerRight: "",
};

export function HeaderFooterPanel({ file, onApplied }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [opts, setOpts] = useState<Options>({
    zones: EMPTY,
    fontSize: 10,
    margin: 24,
    startPage: 1,
    endPage: null,
  });
  const [report, setReport] = useState<Report | null>(null);

  function setZone(key: keyof Zones, v: string) {
    setOpts((o) => ({ ...o, zones: { ...o.zones, [key]: v } }));
  }

  async function handleApply() {
    setReport(null);
    await run(async () => {
      const r = await invoke<Report>("add_header_footer", {
        path: file.path,
        options: opts,
      });
      setReport(r);
      return r.output;
    });
  }

  return (
    <ToolPanelLayout
      onSubmit={handleApply}
      submitLabel="Apply header / footer"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Six text zones (left / center / right × header / footer). Variables:{" "}
        <code>{"{page}"}</code> <code>{"{total}"}</code> <code>{"{filename}"}</code> <code>{"{date}"}</code>.
      </p>

      <div style={{ fontSize: 10.5, color: "var(--viewer-text-sec)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>
        Header
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        <ZoneField label="L" value={opts.zones.headerLeft} onChange={(v) => setZone("headerLeft", v)} />
        <ZoneField label="C" value={opts.zones.headerCenter} onChange={(v) => setZone("headerCenter", v)} />
        <ZoneField label="R" value={opts.zones.headerRight} onChange={(v) => setZone("headerRight", v)} />
      </div>

      <div style={{ fontSize: 10.5, color: "var(--viewer-text-sec)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 }}>
        Footer
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        <ZoneField label="L" value={opts.zones.footerLeft} onChange={(v) => setZone("footerLeft", v)} />
        <ZoneField label="C" value={opts.zones.footerCenter} onChange={(v) => setZone("footerCenter", v)} />
        <ZoneField label="R" value={opts.zones.footerRight} onChange={(v) => setZone("footerRight", v)} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 8 }}>
        <NumField label="Font" value={opts.fontSize} onChange={(v) => setOpts({ ...opts, fontSize: v })} min={4} />
        <NumField label="Margin" value={opts.margin} onChange={(v) => setOpts({ ...opts, margin: v })} min={0} />
        <NumField label="Start" value={opts.startPage} onChange={(v) => setOpts({ ...opts, startPage: Math.max(1, v) })} min={1} />
        <NumField
          label="End"
          value={opts.endPage ?? 0}
          onChange={(v) => setOpts({ ...opts, endPage: v <= 0 ? null : v })}
          min={0}
          allowZero
        />
      </div>

      {report && (
        <div
          style={{
            border: "1px solid var(--v-ok-border)",
            background: "var(--v-ok-bg)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--v-ok-text)",
            fontSize: 11.5,
          }}
        >
          Stamped {report.pagesStamped} page{report.pagesStamped === 1 ? "" : "s"}.
        </div>
      )}

      <button
        type="button"
        disabled={isProcessing}
        onClick={async () => {
          await run(async () => invoke<string>("remove_header_footer", { path: file.path }));
        }}
        style={{
          marginTop: 4,
          padding: "8px 12px",
          background: "var(--viewer-elevated)",
          color: "var(--viewer-text)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 6,
          fontSize: 12.5,
          cursor: isProcessing ? "not-allowed" : "pointer",
        }}
      >
        Remove header / footer
      </button>
    </ToolPanelLayout>
  );
}

function ZoneField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--viewer-text-muted)" }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder=""
        style={{
          padding: "5px 6px",
          background: "var(--viewer-elevated)",
          color: "var(--viewer-text)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 4,
          fontSize: 11.5,
        }}
      />
    </label>
  );
}

function NumField({ label, value, onChange, min, allowZero }: {
  label: string; value: number; onChange: (v: number) => void; min: number; allowZero?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "var(--viewer-text-muted)" }}>{label}</span>
      <input
        type="number"
        min={allowZero ? 0 : min}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          onChange(Math.max(allowZero ? 0 : min, v));
        }}
        style={{
          padding: "5px 6px",
          background: "var(--viewer-elevated)",
          color: "var(--viewer-text)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 4,
          fontSize: 11.5,
          textAlign: "right",
        }}
      />
    </label>
  );
}
