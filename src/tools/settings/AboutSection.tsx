import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SectionTitle, SettingRow } from "./ui";

export function AboutSection() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  return (
    <div>
      <SectionTitle>About</SectionTitle>
      <div className="flex items-center gap-3 mb-4">
        <img src="/Logo.png" alt="Qyra" className="w-12 h-12 rounded-full object-contain" />
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--fg0)" }}>Qyra {version}</div>
          <div className="text-xs" style={{ color: "var(--fg2)" }}>free · offline · open source</div>
        </div>
      </div>
      <SettingRow label="Source code" description="View the project on GitHub.">
        <button
          onClick={() => openUrl("https://github.com/zParik/Qyra").catch(() => {})}
          className="text-xs px-3 py-1.5 rounded"
          style={{ background: "var(--bg2)", color: "var(--fg1)" }}
        >
          Open
        </button>
      </SettingRow>
    </div>
  );
}
