import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { LabeledInput } from "../components/LabeledInput";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

interface BatesOptions {
  prefix: string;
  suffix: string;
  startAt: number;
  increment: number;
  digits: number;
  position: string;
  fontSize: number;
  margin: number;
}

interface BatesResult {
  output: string;
  firstLabel: string;
  lastLabel: string;
  pageCount: number;
}

const POSITIONS = [
  "bottom-left", "bottom-center", "bottom-right",
  "top-left", "top-center", "top-right",
];

const DEFAULTS: BatesOptions = {
  prefix: "CASE-",
  suffix: "",
  startAt: 1,
  increment: 1,
  digits: 6,
  position: "bottom-right",
  fontSize: 9,
  margin: 18,
};

export function BatesPanel({ file, onApplied }: Props) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [opts, setOpts] = useState<BatesOptions>(DEFAULTS);
  const [report, setReport] = useState<BatesResult | null>(null);

  function set<K extends keyof BatesOptions>(k: K, v: BatesOptions[K]) {
    setOpts((o) => ({ ...o, [k]: v }));
  }

  const previewSeq = (i: number) => {
    const seq = opts.startAt + i * Math.max(1, opts.increment);
    return `${opts.prefix}${String(seq).padStart(Math.max(1, opts.digits), "0")}${opts.suffix}`;
  };

  async function handle() {
    setReport(null);
    await run(async () => {
      const r = await invoke<BatesResult>("add_bates_numbers", {
        path: file.path,
        options: opts,
      });
      setReport(r);
      return r.output;
    });
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Apply Bates numbers"
      submitClassName="v-btn-primary w-full"
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Adds prefix + zero-padded sequence to every page (legal-discovery style).
        Removable via the &quot;Remove Bates&quot; action.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <LabeledInput label="Prefix" value={opts.prefix} onChange={(v) => set("prefix", v)} placeholder="CASE-" />
        <LabeledInput label="Suffix" value={opts.suffix} onChange={(v) => set("suffix", v)} placeholder="" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <LabeledInput label="Start" type="number" value={String(opts.startAt)}
          onChange={(v) => set("startAt", Math.max(0, parseInt(v) || 0))} />
        <LabeledInput label="Increment" type="number" value={String(opts.increment)}
          onChange={(v) => set("increment", Math.max(1, parseInt(v) || 1))} />
        <LabeledInput label="Digits" type="number" value={String(opts.digits)}
          onChange={(v) => set("digits", Math.max(1, Math.min(12, parseInt(v) || 6)))} />
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="text-xs" style={{ color: "var(--viewer-text-sec)" }}>Position</span>
        <select
          value={opts.position}
          onChange={(e) => set("position", e.target.value)}
          style={{
            padding: "6px 8px",
            background: "var(--viewer-elevated)",
            border: "1px solid var(--viewer-border)",
            borderRadius: 6,
            color: "var(--viewer-text)",
            fontSize: 12,
          }}
        >
          {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <LabeledInput label="Font size" type="number" value={String(opts.fontSize)}
          onChange={(v) => set("fontSize", Math.max(4, parseFloat(v) || 9))} />
        <LabeledInput label="Margin (pt)" type="number" value={String(opts.margin)}
          onChange={(v) => set("margin", Math.max(0, parseFloat(v) || 18))} />
      </div>

      <div
        style={{
          background: "var(--viewer-elevated)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 6,
          padding: "8px 10px",
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
          color: "var(--viewer-text)",
          display: "flex", flexDirection: "column", gap: 2,
        }}
      >
        <span style={{ color: "var(--viewer-text-muted)" }}>Preview</span>
        <span>page 1 → {previewSeq(0)}</span>
        <span>page 2 → {previewSeq(1)}</span>
        <span>page n → {previewSeq(2)}</span>
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
          Stamped {report.pageCount} pages — {report.firstLabel} to {report.lastLabel}
        </div>
      )}

      <button
        type="button"
        disabled={isProcessing}
        onClick={async () => {
          await run(async () => {
            return invoke<string>("remove_bates_numbers", { path: file.path });
          });
        }}
        style={{
          padding: "8px 12px",
          background: "var(--viewer-elevated)",
          color: "var(--viewer-text)",
          border: "1px solid var(--viewer-border)",
          borderRadius: 6,
          fontSize: 12.5,
          cursor: isProcessing ? "not-allowed" : "pointer",
        }}
      >
        Remove Bates numbers
      </button>
    </ToolPanelLayout>
  );
}
