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
      <div className="about-card">
        <span className="about-mark" aria-hidden="true">
          <svg width={28} height={28} viewBox="0 0 20 20" fill="none">
            <path d="M10 1.5c3.6 0 6 3.2 6 7.2 0 3.6-2.6 6.3-6 6.3s-6-2.7-6-6.3c0-4 2.4-7.2 6-7.2z" stroke="currentColor" strokeWidth={1.4} />
            <ellipse cx="10" cy="8.8" rx="2.6" ry="3.2" fill="currentColor" opacity="0.9" />
            <circle cx="10" cy="8.4" r="1" fill="var(--shell)" />
            <path d="M10 15v3.5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          </svg>
        </span>
        <div>
          <div className="about-name">Qyra <span className="t-num" style={{ color: "var(--fg2)", fontWeight: 400 }}>{version}</span></div>
          <div className="t-meta">Free, offline and open source. Your files never leave this computer.</div>
        </div>
      </div>
      <SettingRow label="Source code" description="The whole project is on GitHub under GPL-3.0.">
        <button
          type="button"
          onClick={() => openUrl("https://github.com/zParik/Qyra").catch(() => {})}
          className="btn-secondary btn-sm"
        >
          Open GitHub
        </button>
      </SettingRow>
    </div>
  );
}
