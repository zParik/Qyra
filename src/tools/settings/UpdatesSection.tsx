import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "../../hooks/useUpdater";
import { SectionTitle, SettingRow } from "./ui";

export function UpdatesSection() {
  const { state, checkForUpdates } = useUpdater();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  const statusLabel =
    state.status === "checking" ? "Checking…" :
    state.status === "available" ? "An update is available. See the banner at the top." :
    state.status === "downloading" ? "Downloading…" :
    state.status === "ready" ? "Downloaded. Restart Qyra to apply it." :
    "Up to date.";

  return (
    <div>
      <SectionTitle note="Updates come from GitHub releases. Nothing else is ever sent or fetched.">Updates</SectionTitle>
      <SettingRow label="Installed version" description={statusLabel}>
        <span className="t-num" style={{ color: "var(--fg1)" }}>{version || "…"}</span>
      </SettingRow>
      <SettingRow label="Check for updates" description="Look at GitHub releases now.">
        <button
          type="button"
          onClick={() => checkForUpdates()}
          disabled={state.status === "checking" || state.status === "downloading"}
          className="btn-secondary btn-sm"
        >
          Check now
        </button>
      </SettingRow>
    </div>
  );
}
