import { useSetting } from "../../hooks/useSetting";
import { Settings, CompressLevel } from "../../lib/settings";
import { pickDirectory } from "../../lib/tauri";
import { SectionTitle, SettingRow, Toggle, Segmented } from "./ui";

const LEVELS: { value: CompressLevel; label: string }[] = [
  { value: 0, label: "Lossless" },
  { value: 1, label: "Lossy" },
  { value: 2, label: "Aggressive" },
];

export function FilesSection() {
  const [level, setLevel] = useSetting(Settings.defaultCompressLevel);
  const [confirmOverwrite, setConfirmOverwrite] = useSetting(Settings.confirmBeforeOverwrite);
  const [saveFolder, setSaveFolder] = useSetting(Settings.defaultSaveFolder);

  async function browseFolder() {
    const picked = await pickDirectory();
    if (picked) setSaveFolder(picked);
  }

  return (
    <div>
      <SectionTitle note="How Qyra writes files back to disk.">Files</SectionTitle>

      <SettingRow label="Default compression" description="The level the Compress tool starts from.">
        <Segmented options={LEVELS} value={level} onChange={setLevel} label="Default compression level" />
      </SettingRow>

      <SettingRow
        label="Confirm before overwriting"
        description="Ask before saving over the original file with Ctrl+S."
      >
        <Toggle checked={confirmOverwrite} onChange={setConfirmOverwrite} label="Confirm before overwriting" />
      </SettingRow>

      <SettingRow
        label="Default save folder"
        description="The folder the Save dialog opens in."
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span className="t-meta" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={saveFolder || undefined}>
            {saveFolder || "Not set"}
          </span>
          <button type="button" onClick={browseFolder} className="btn-secondary btn-sm">
            Choose…
          </button>
          {saveFolder && (
            <button type="button" onClick={() => setSaveFolder("")} className="btn-ghost btn-sm">
              Clear
            </button>
          )}
        </div>
      </SettingRow>
    </div>
  );
}
