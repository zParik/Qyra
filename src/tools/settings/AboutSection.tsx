import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SectionTitle, SettingRow } from "./ui";
import { PeacockMark } from "../../components/Wordmark";

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
          <PeacockMark size={32} />
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
