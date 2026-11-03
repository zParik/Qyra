import { ThemeToggle } from "../../components/ThemeToggle";
import { SettingRow, SectionTitle } from "./ui";

export function AppearanceSection() {
  return (
    <div>
      <SectionTitle note="Qyra is a bright shop by day and an indigo one at night. Pages stay white either way.">
        Appearance
      </SectionTitle>
      <SettingRow label="Theme" description="Follow the system, or keep it light or dark.">
        <div style={{ width: 260 }}>
          <ThemeToggle variant="rail" />
        </div>
      </SettingRow>
    </div>
  );
}
