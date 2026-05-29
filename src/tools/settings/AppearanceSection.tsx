import { useTheme, ThemeChoice } from "../../lib/useTheme";
import { SettingRow, SectionTitle } from "./ui";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>
      <SettingRow label="Theme" description="Match the system or force a fixed theme.">
        <div className="flex gap-1">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              onClick={() => setTheme(c.value)}
              className="text-xs px-3 py-1.5 rounded"
              style={
                theme === c.value
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--bg2)", color: "var(--fg1)" }
              }
            >
              {c.label}
            </button>
          ))}
        </div>
      </SettingRow>
    </div>
  );
}
