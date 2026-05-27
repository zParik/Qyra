import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";

interface Props {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

interface AnonymizeOptions {
  stripInfo: boolean;
  stripXmpMetadata: boolean;
  stripJavascript: boolean;
  stripEmbeddedFiles: boolean;
  stripOpenActions: boolean;
  stripAnnotAuthors: boolean;
}

interface AnonymizeReport {
  output: string;
  infoFieldsRemoved: number;
  xmpRemoved: boolean;
  namesRemoved: boolean;
  openActionRemoved: boolean;
  additionalActionsRemoved: boolean;
  annotAuthorsRemoved: number;
}

const DEFAULTS: AnonymizeOptions = {
  stripInfo: true,
  stripXmpMetadata: true,
  stripJavascript: true,
  stripEmbeddedFiles: true,
  stripOpenActions: true,
  stripAnnotAuthors: true,
};

const ROWS: { key: keyof AnonymizeOptions; label: string; desc: string }[] = [
  { key: "stripInfo", label: "Document Info dictionary",
    desc: "Title, Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate." },
  { key: "stripXmpMetadata", label: "XMP metadata stream",
    desc: "Removes the /Metadata stream that mirrors Info and may contain extra identifiers." },
  { key: "stripJavascript", label: "JavaScript",
    desc: "Strips form-level JavaScript and the /Names JavaScript tree." },
  { key: "stripEmbeddedFiles", label: "Embedded files / attachments",
    desc: "Removes the /Names EmbeddedFiles tree (also drops named destinations)." },
  { key: "stripOpenActions", label: "Auto-actions on open",
    desc: "Removes /OpenAction and /AA so the document cannot run actions when opened." },
  { key: "stripAnnotAuthors", label: "Annotation author + UUIDs",
    desc: "Per-annotation /T author, /M timestamp, and /NM identifier." },
];

export function AnonymizePanel({ file, onApplied }: Props) {
  const { isProcessing, result, error, run, clearError } =
    usePanelCommand((path) => { onApplied(path); });
  const [opts, setOpts] = useState<AnonymizeOptions>(DEFAULTS);
  const [report, setReport] = useState<AnonymizeReport | null>(null);

  function toggle(key: keyof AnonymizeOptions) {
    setOpts((o) => ({ ...o, [key]: !o[key] }));
  }

  async function handle() {
    setReport(null);
    await run(async () => {
      const r = await invoke<AnonymizeReport>("anonymize_pdf", {
        path: file.path,
        options: opts,
      });
      setReport(r);
      return r.output;
    });
  }

  const noneSelected = !Object.values(opts).some(Boolean);

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Anonymize PDF"
      submitClassName="v-btn-primary w-full"
      submitDisabled={noneSelected}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      <p className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.55 }}>
        Strips identifying metadata and active content from the PDF without altering
        the visible page contents.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {ROWS.map(({ key, label, desc }) => (
          <label
            key={key}
            style={{
              display: "flex", alignItems: "flex-start", gap: 8,
              padding: "6px 8px",
              border: "1px solid var(--viewer-border)",
              borderRadius: 6,
              cursor: "pointer",
              background: opts[key] ? "var(--v-warn-bg)" : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={opts[key]}
              onChange={() => toggle(key)}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1 }}>
              <span className="text-xs" style={{ color: "var(--viewer-text)", fontWeight: 500 }}>
                {label}
              </span>
              <span className="text-xs" style={{ color: "var(--viewer-text-muted)", lineHeight: 1.45 }}>
                {desc}
              </span>
            </span>
          </label>
        ))}
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
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Removed</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {report.infoFieldsRemoved > 0 && <li>{report.infoFieldsRemoved} Info field(s)</li>}
            {report.xmpRemoved && <li>XMP metadata stream</li>}
            {report.namesRemoved && <li>/Names tree (JS + embedded files)</li>}
            {report.openActionRemoved && <li>/OpenAction</li>}
            {report.additionalActionsRemoved && <li>/AA additional actions</li>}
            {report.annotAuthorsRemoved > 0 && <li>{report.annotAuthorsRemoved} annotation author/UUID field(s)</li>}
          </ul>
        </div>
      )}

      <div
        style={{
          background: "var(--v-warn-bg)",
          border: "1px solid var(--v-warn-border)",
          borderRadius: 7,
          padding: "8px 10px",
        }}
      >
        <p className="text-xs" style={{ color: "var(--v-warn-text)", lineHeight: 1.5 }}>
          Does not redact visible page content. Use the Redact tool to remove text or
          images from rendered pages.
        </p>
      </div>
    </ToolPanelLayout>
  );
}
