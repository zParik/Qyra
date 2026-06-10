import { useSetting } from "../../hooks/useSetting";
import { Settings, CompressLevel } from "../../lib/settings";
import { isAndroid, pickSaveFolderAndroid, saveFolderLabel } from "../../lib/androidFileUtils";
import { pickDirectory } from "../../lib/tauri";
import { SectionTitle, SettingRow, Toggle } from "./ui";

const LEVELS: { value: CompressLevel; label: string }[] = [
  { value: 0, label: "Lossless" },
  { value: 1, label: "Lossy" },
  { value: 2, label: "Aggressive" },
];

function Segmented<T extends string | number>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className="text-xs px-2.5 py-1.5 rounded"
          style={
            value === o.value
              ? { background: "var(--accent)", color: "#fff" }
              : { background: "var(--bg2)", color: "var(--fg1)" }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FilesSection() {
  const android = isAndroid();
  const [level, setLevel] = useSetting(Settings.defaultCompressLevel);
  const [confirmOverwrite, setConfirmOverwrite] = useSetting(Settings.confirmBeforeOverwrite);
  const [saveFolder, setSaveFolder] = useSetting(Settings.defaultSaveFolder);

  async function browseFolder() {
    const picked = android ? await pickSaveFolderAndroid() : await pickDirectory();
    if (picked) setSaveFolder(picked);
  }

  return (
    <div>
      <SectionTitle>Files</SectionTitle>

      <SettingRow label="Default compression level" description="Native compression level used by the Compress tool.">
        <Segmented options={LEVELS} value={level} onChange={setLevel} />
      </SettingRow>

      <SettingRow
        label="Confirm before overwriting"
        description="Ask before saving over the original file (Ctrl+S)."
      >
        <Toggle checked={confirmOverwrite} onChange={setConfirmOverwrite} />
      </SettingRow>

      <SettingRow
        label="Default save folder"
        description={android
          ? "Saved/exported PDFs go here instead of Downloads."
          : "Pre-selected folder in the Save dialog."}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs max-w-[180px] truncate" style={{ color: "var(--fg2)" }}>
            {saveFolderLabel(saveFolder)}
          </span>
          <button onClick={browseFolder} className="text-xs px-3 py-1.5 rounded"
            style={{ background: "var(--bg2)", color: "var(--fg1)" }}>
            Browse
          </button>
          {saveFolder && (
            <button onClick={() => setSaveFolder("")} className="text-xs px-2 py-1.5 rounded"
              style={{ background: "var(--bg2)", color: "var(--fg2)" }}>
              Clear
            </button>
          )}
        </div>
      </SettingRow>
    </div>
  );
}
