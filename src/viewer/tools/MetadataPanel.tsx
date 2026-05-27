import { useState, useEffect } from "react";
import { LoadedFile } from "../../store/useAppStore";
import { usePanelCommand } from "../usePanelCommand";
import { ToolPanelLayout } from "../components/ToolPanelLayout";
import { LabeledInput } from "../components/LabeledInput";
import {
  setMetadata, getMetadata, getPdfPermissions,
  PdfMetadata, PdfPermissions,
} from "../../lib/tauri";

const FIELDS: { key: keyof PdfMetadata; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "subject", label: "Subject" },
  { key: "keywords", label: "Keywords" },
  { key: "creator", label: "Creator" },
];

const PERM_ROWS: { key: keyof PdfPermissions; label: string }[] = [
  { key: "print", label: "Print" },
  { key: "printHighQuality", label: "Print (high quality)" },
  { key: "copyExtract", label: "Copy text and graphics" },
  { key: "modifyContents", label: "Modify contents" },
  { key: "annotate", label: "Annotate" },
  { key: "fillForms", label: "Fill form fields" },
  { key: "assemble", label: "Assemble (rotate, delete, insert pages)" },
  { key: "accessibilityExtract", label: "Extract for accessibility" },
];

interface MetadataPanelProps {
  file: LoadedFile;
  onApplied: (path: string) => void;
}

export function MetadataPanel({ file, onApplied }: MetadataPanelProps) {
  const { isProcessing, result, error, run, clearError } = usePanelCommand(onApplied);
  const [meta, setMeta] = useState<PdfMetadata>({});
  const [perms, setPerms] = useState<PdfPermissions | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setMeta({});
    setPerms(null);
    Promise.allSettled([
      getMetadata(file.path),
      getPdfPermissions(file.path),
    ]).then(([m, p]) => {
      if (m.status === "fulfilled") setMeta(m.value);
      if (p.status === "fulfilled") setPerms(p.value);
      setLoaded(true);
    });
  }, [file.path]);

  async function handle() {
    await run(() => setMetadata(file.path, meta));
  }

  return (
    <ToolPanelLayout
      onSubmit={handle}
      submitLabel="Save Metadata"
      submitDisabled={!loaded}
      isProcessing={isProcessing}
      result={result}
      error={error}
      onClearError={clearError}
    >
      {!loaded && (
        <p className="text-xs" style={{ color: "var(--viewer-text-muted)" }}>Loading metadata...</p>
      )}

      {loaded && FIELDS.map(({ key, label }) => (
        <LabeledInput
          key={key}
          label={label}
          value={meta[key] ?? ""}
          onChange={(v) => setMeta((m) => ({ ...m, [key]: v || undefined }))}
          placeholder={label}
        />
      ))}

      {loaded && perms && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 11.5, fontWeight: 600,
              color: "var(--viewer-text-sec)",
              textTransform: "uppercase", letterSpacing: 0.4,
              marginBottom: 8,
            }}
          >
            Permissions
            <span
              style={{
                fontWeight: 500,
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 3,
                background: perms.encrypted ? "var(--v-warn-bg)" : "var(--v-ok-bg)",
                color: perms.encrypted ? "var(--v-warn-text)" : "var(--v-ok-text)",
                border: `1px solid ${perms.encrypted ? "var(--v-warn-border)" : "var(--v-ok-border)"}`,
                textTransform: "none", letterSpacing: 0,
              }}
            >
              {perms.encrypted
                ? `Encrypted${perms.algorithm ? ` · ${perms.algorithm}` : ""}`
                : "Unprotected"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "4px 12px",
              fontSize: 12,
              color: "var(--viewer-text)",
            }}
          >
            {PERM_ROWS.map(({ key, label }) => {
              const allowed = Boolean(perms[key]);
              return (
                <PermRow key={String(key)} label={label} allowed={allowed} />
              );
            })}
          </div>

          {perms.encrypted && perms.pValue !== null && (
            <div
              style={{
                marginTop: 8,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 10.5,
                color: "var(--viewer-text-muted)",
              }}
            >
              /P = {perms.pValue}{perms.revision !== null ? ` · R = ${perms.revision}` : ""}
            </div>
          )}
        </div>
      )}
    </ToolPanelLayout>
  );
}

function PermRow({ label, allowed }: { label: string; allowed: boolean }) {
  return (
    <>
      <span style={{ color: "var(--viewer-text)" }}>{label}</span>
      <span
        style={{
          color: allowed ? "var(--v-ok-text)" : "var(--v-bad-text)",
          fontSize: 11.5,
          fontWeight: 500,
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        {allowed ? (
          <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8.5l3.5 3.5L13 5" />
          </svg>
        ) : (
          <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        )}
        {allowed ? "Allowed" : "Denied"}
      </span>
    </>
  );
}
