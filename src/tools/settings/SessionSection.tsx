import { useSetting } from "../../hooks/useSetting";
import { Settings } from "../../lib/settings";
import { SectionTitle, SettingRow, Toggle } from "./ui";

export function SessionSection() {
  const [reopen, setReopen] = useSetting(Settings.reopenTabsOnLaunch);
  const [autoSave, setAutoSave] = useSetting(Settings.autoSave);
  return (
    <div>
      <SectionTitle note="What happens between one sitting and the next.">Session</SectionTitle>
      <SettingRow
        label="Reopen tabs on launch"
        description="Restore the PDFs that were open when you last closed Qyra."
      >
        <Toggle checked={reopen} onChange={setReopen} label="Reopen tabs on launch" />
      </SettingRow>
      <SettingRow
        label="Auto-save"
        description="Save edits to the open PDF automatically as you work."
      >
        <Toggle checked={autoSave} onChange={setAutoSave} label="Auto-save" />
      </SettingRow>
    </div>
  );
}
